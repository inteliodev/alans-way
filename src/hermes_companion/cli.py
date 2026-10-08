"""Local diagnostics, print-only configuration, and explicit Mac verification."""
from __future__ import annotations

import argparse
import asyncio
from contextlib import contextmanager
import importlib.metadata
import json
import logging
import math
import os
import shutil
import sys
import tempfile
from collections.abc import Sequence

from . import __version__
from .config import MAC_TOOLS, build_mcp_config, validate_absolute_path

SDK_VERSION = "2.0.0"


def _load_sdk():
    """Load the tested optional SDK lazily; incompatible releases fail closed."""
    if importlib.metadata.version("mcp") != SDK_VERSION:
        raise ImportError("unsupported MCP SDK")
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client, get_default_environment
    from anyio import fail_after
    return ClientSession, StdioServerParameters, stdio_client, get_default_environment, fail_after


def _sdk_available() -> bool:
    try:
        _load_sdk()
    except Exception:
        return False
    return True


def doctor() -> dict:
    """Inspect local component/dependency availability without running programs."""
    try:
        importlib.metadata.version("hermes-companion")
        installed = True
    except importlib.metadata.PackageNotFoundError:
        installed = False
    return {
        "component_available": True,
        "component_version": __version__,
        "distribution_installed": installed,
        "sdk_available": _sdk_available(),
        "sdk_required_version": SDK_VERSION,
        "ssh_available": shutil.which("ssh") is not None,
        "hermes_available": shutil.which("hermes") is not None,
        "local_only": True,
        "connection_verified": False,
        "full_integration_ready": False,
        "limitations": [
            "Authenticated multi-client routing is not integrated.",
            "Companion approval integration is not implemented.",
            "SSH identity and remote workspace access are not checked by doctor.",
        ],
    }


class VerificationError(RuntimeError):
    """A fixed, public-safe explanation, never an SDK or SSH error dump."""


@contextmanager
def _private_sdk_log(errlog):
    """Keep SDK parse/protocol diagnostics local and restore logger state."""
    logger = logging.getLogger("mcp")
    handlers, propagate = logger.handlers[:], logger.propagate
    capture = logging.StreamHandler(errlog)
    logger.handlers = [capture]
    logger.propagate = False
    try:
        yield
    finally:
        logger.handlers = handlers
        logger.propagate = propagate
        capture.close()


def _tool_payload(result) -> dict:
    if result.is_error:
        raise VerificationError("Mac tool returned an error; verification stopped")
    payload = result.structured_content
    if not isinstance(payload, dict):
        # Accept standards-compliant JSON text results as well as SDK structure.
        if len(result.content) != 1 or getattr(result.content[0], "type", None) != "text":
            raise VerificationError("Mac tool returned an invalid response")
        text = result.content[0].text
        if not isinstance(text, str) or len(text) > 262144:
            raise VerificationError("Mac tool returned an invalid response")
        try:
            payload = json.loads(text)
        except (ValueError, TypeError):
            raise VerificationError("Mac tool returned an invalid response") from None
    if not isinstance(payload, dict):
        raise VerificationError("Mac tool returned an invalid response")
    return payload


async def _verify_connection(server: dict, sdk, request_timeout: float, overall_timeout: float,
                             read_path: str | None = None) -> dict:
    ClientSession, StdioServerParameters, stdio_client, get_default_environment, fail_after = sdk
    env = get_default_environment()
    agent_socket = os.environ.get("SSH_AUTH_SOCK")
    if agent_socket and not agent_socket.startswith("()") and "\x00" not in agent_socket:
        env["SSH_AUTH_SOCK"] = agent_socket
    params = StdioServerParameters(command=server["command"], args=server["args"], env=env)
    # Unnamed temporary capture is closed/deleted and never included in reports.
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as errlog, _private_sdk_log(errlog):
        # AnyIO cancellation cooperates with the SDK's shielded shutdown;
        # asyncio.timeout can interrupt that cleanup and leave a pipe drain hung.
        with fail_after(overall_timeout):
            async with stdio_client(params, errlog=errlog) as (reader, writer):
                async with ClientSession(reader, writer, read_timeout_seconds=request_timeout) as session:
                    await session.initialize()
                    listing = await session.list_tools()
                    names = [tool.name for tool in listing.tools]
                    if (len(names) != len(MAC_TOOLS) or set(names) != set(MAC_TOOLS)
                            or listing.next_cursor is not None):
                        raise VerificationError("Unexpected Mac tool set; verification stopped")
                    if any(tool.annotations is None or tool.annotations.read_only_hint is not True
                           for tool in listing.tools):
                        raise VerificationError("Mac tools lack required read-only annotations")
                    status = _tool_payload(await session.call_tool("mac_device_status", {}))
                    if status.get("execution_host") != "mac" or status.get("system") != "Darwin":
                        raise VerificationError("Mac identity could not be confirmed; verification stopped")
                    report = {
                        "connection_verified": True, "full_integration_ready": False,
                        "execution_host": "mac", "system": "Darwin",
                        "tools": list(MAC_TOOLS), "read_performed": False,
                    }
                    if read_path is not None:
                        read = _tool_payload(await session.call_tool("mac_workspace_read_file", {"path": read_path}))
                        if (read.get("execution_host") != "mac" or read.get("path") != read_path
                                or not isinstance(read.get("content"), str)):
                            raise VerificationError("Mac read identity or result could not be confirmed")
                        byte_count = len(read["content"].encode("utf-8"))
                        if byte_count > 65536:
                            raise VerificationError("Mac read exceeded the bounded fixture size")
                        report["read_performed"] = True
                        report["read"] = {"bytes_read": byte_count, "encoding": "utf-8"}
                    return report


def _validate_read_path(value: str) -> str:
    if (not isinstance(value, str) or not value or value.startswith("/") or "\\" in value
            or ":" in value or len(value) > 1024
            or any(part in ("", ".", "..") for part in value.split("/"))
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise ValueError("--read must be an explicit workspace-relative fixture path without traversal or control characters")
    return value


def _validate_timeout(value: float, maximum: float) -> float:
    if (isinstance(value, bool) or not isinstance(value, (float, int))
            or not math.isfinite(value) or not 0 < value <= maximum):
        raise ValueError("timeouts must be finite positive seconds within the supported bounds")
    return float(value)


def verify_mac(mac_host: str, mac_python: str, workspace: str, *, read_path: str | None = None,
               request_timeout: float = 10.0, overall_timeout: float = 30.0) -> dict:
    """Explicitly check SSH + the real MCP protocol, without retries or fallback.

    Overall protocol work is bounded; the SDK additionally uses bounded cleanup
    when stopping the SSH child. No file is read unless read_path is supplied.
    """
    server = build_mcp_config(mac_host, mac_python, workspace)["mcp_servers"]["mac_companion"]
    if read_path is not None:
        _validate_read_path(read_path)
    request_timeout = _validate_timeout(request_timeout, 30.0)
    overall_timeout = _validate_timeout(overall_timeout, 120.0)
    try:
        sdk = _load_sdk()
    except Exception:
        raise VerificationError("Verification requires the optional hermes-companion[mcp] extra with mcp==2.0.0") from None
    try:
        return asyncio.run(_verify_connection(server, sdk, request_timeout, overall_timeout, read_path))
    except VerificationError:
        raise
    except Exception:
        raise VerificationError("Mac connection or protocol verification failed; no retry or fallback was attempted") from None


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        # argparse's message can echo a malicious destination or secret argument.
        self.print_usage(sys.stderr)
        self.exit(2, "hermes-companion: invalid or missing arguments; use --help\n")


def _parser() -> argparse.ArgumentParser:
    parser = _Parser(prog="hermes-companion", description="Print-only companion setup; no config or service changes.")
    parser.add_argument("--version", action="store_true", help="show version without importing the MCP SDK")
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("doctor", help="check local dependencies only, without network calls")
    serve = commands.add_parser("serve-mac", help="explicitly run the scoped read-only Mac MCP server")
    serve.add_argument("--workspace", required=True, help="absolute approved local workspace")
    for name, help_text in (
        ("mcp-config", "print a scoped SSH MCP JSON fragment; never connect or apply"),
        ("verify-mac", "explicitly verify one private SSH MCP connection; no config writes"),
    ):
        connection = commands.add_parser(name, help=help_text)
        connection.add_argument("--mac-host", required=True, help="literal user@private-host")
        connection.add_argument("--mac-python", required=True, help="absolute remote virtualenv Python path")
        connection.add_argument("--workspace", required=True, help="absolute approved remote workspace")
        if name == "verify-mac":
            connection.add_argument("--read", dest="read_path", help="opt in to reading this relative synthetic fixture; content is never printed")
            connection.add_argument("--request-timeout", type=float, default=10.0, help="per-request seconds (0 < value <= 30)")
            connection.add_argument("--overall-timeout", type=float, default=30.0, help="overall protocol seconds (0 < value <= 120), plus bounded SDK cleanup")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    if args.version:
        print(f"hermes-companion {__version__}")
        return 0
    if args.command is None:
        parser.print_help()
        return 0
    if args.command == "doctor":
        report = doctor()
        print(json.dumps(report, indent=2))
        return 0 if all(report[key] for key in ("sdk_available", "ssh_available", "hermes_available")) else 1
    if args.command == "serve-mac":
        try:
            validate_absolute_path(args.workspace)
        except ValueError as exc:
            print(f"hermes-companion: {exc}", file=sys.stderr)
            return 2
        try:
            from .mac_server import main as server_main
            return server_main(["--workspace", args.workspace])
        except Exception:
            print("hermes-companion: Mac server unavailable or failed; requires Darwin and the optional MCP SDK", file=sys.stderr)
            return 1
    if args.command == "verify-mac":
        try:
            report = verify_mac(args.mac_host, args.mac_python, args.workspace,
                                read_path=args.read_path, request_timeout=args.request_timeout,
                                overall_timeout=args.overall_timeout)
        except ValueError as exc:
            print(f"hermes-companion: {exc}", file=sys.stderr)
            return 2
        except VerificationError as exc:
            print(f"hermes-companion: {exc}", file=sys.stderr)
            return 1
        except KeyboardInterrupt:
            print("hermes-companion: verification interrupted; no retry or fallback", file=sys.stderr)
            return 130
        print(json.dumps(report, indent=2))
        return 0
    try:
        config = build_mcp_config(args.mac_host, args.mac_python, args.workspace)
    except ValueError as exc:
        print(f"hermes-companion: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(config, indent=2))
    return 0
