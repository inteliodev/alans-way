"""The intelio computers MCP relay works with the official Python `mcp` client.

Hermes connects to http://127.0.0.1:8645/mcp with the streamable-HTTP client
(docs/intelio-node.md). This starts the relay plus a fake enrolled computer
(tests/intelio_nodes_fixture.cjs, needs `node`) and drives it with `mcp`.
"""

import asyncio
import contextlib
import json
import os
import secrets
import shutil
import subprocess
import unittest
from pathlib import Path

try:
    import mcp  # noqa: F401
    from mcp import ClientSession
    from mcp.client import streamable_http as _sh
except ImportError:  # pragma: no cover - CI installs mcp; local runs may not
    mcp = None

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "intelio_nodes_fixture.cjs"


@contextlib.asynccontextmanager
async def _client(url, token):
    """streamable_http_client (mcp 2.x) or streamablehttp_client (mcp 1.x)."""
    headers = {"Authorization": f"Bearer {token}"}
    if hasattr(_sh, "streamable_http_client"):
        async with _sh.create_mcp_http_client(headers=headers) as http_client:
            async with _sh.streamable_http_client(url, http_client=http_client) as streams:
                yield streams
        return
    async with _sh.streamablehttp_client(url, headers=headers) as streams:
        yield streams


@unittest.skipIf(mcp is None, "mcp package not installed")
@unittest.skipIf(shutil.which("node") is None, "node not on PATH")
class IntelioNodesMcpTest(unittest.TestCase):
    def setUp(self):
        self.token = secrets.token_hex(32)
        env = dict(os.environ, INTELIO_TEST_TOKEN=self.token)
        self.proc = subprocess.Popen(
            ["node", str(FIXTURE)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
        )
        line = self.proc.stdout.readline()
        if not line:
            self.fail(f"fixture did not start: {self.proc.stderr.read()}")
        self.url = f"http://127.0.0.1:{json.loads(line)['mcp_port']}/mcp"

    def tearDown(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:  # pragma: no cover
            self.proc.kill()
        self.proc.stdout.close()
        self.proc.stderr.close()

    async def _session(self, token):
        async with _client(self.url, token) as streams:
            read, write = streams[0], streams[1]
            async with ClientSession(read, write) as session:
                init = await session.initialize()
                tools = await session.list_tools()
                computers = await session.call_tool("list_computers", {})
                info = await session.call_tool("computer_info", {"computer": "py-test-pc"})
                missing = await session.call_tool("computer_info", {"computer": "nope"})
                return init, tools, computers, info, missing

    async def _terminal(self):
        async with _client(self.url, self.token) as streams:
            read, write = streams[0], streams[1]
            async with ClientSession(read, write) as session:
                await session.initialize()
                started = await session.call_tool(
                    "start_session", {"computer": "py-test-pc", "command": "claude", "cwd": "~/code"}
                )
                first = await session.call_tool(
                    "read_output", {"computer": "py-test-pc", "session_id": "s_0123456789ab", "wait_ms": 1000}
                )
                later = await session.call_tool(
                    "read_output", {"computer": "py-test-pc", "session_id": "s_0123456789ab", "since": 11, "wait_ms": 0}
                )
                return started, first, later

    def test_terminal_session_tools_with_the_official_client(self):
        started, first, later = asyncio.run(asyncio.wait_for(self._terminal(), timeout=60))
        self.assertFalse(getattr(started, "is_error", getattr(started, "isError", None)))
        meta = json.loads(started.content[0].text)
        self.assertEqual(meta["session_id"], "s_0123456789ab")
        self.assertTrue(meta["pty"])
        self.assertEqual(meta["command"], "claude")
        self.assertFalse(getattr(first, "is_error", getattr(first, "isError", None)))
        self.assertEqual(len(first.content), 2)
        read_meta = json.loads(first.content[0].text)
        self.assertEqual(read_meta["cursor"], len("Welcome to Claude Code\n> "))
        self.assertFalse(read_meta["exited"])
        self.assertIn("Welcome to Claude Code", first.content[1].text)
        self.assertEqual(later.content[1].text, "Claude Code\n> ")

    def test_list_and_call_with_the_official_client(self):
        init, tools, computers, info, missing = asyncio.run(self._session(self.token))
        self.assertEqual(init.server_info.name if hasattr(init, "server_info") else init.serverInfo.name, "intelio-computers")
        names = [tool.name for tool in tools.tools]
        self.assertEqual(
            names,
            [
                "list_computers",
                "computer_info",
                "list_dir",
                "read_file",
                "write_file",
                "search_files",
                "run_command",
                "screenshot",
                "start_session",
                "send_input",
                "read_output",
                "stop_session",
                "list_sessions",
            ],
        )
        listed = json.loads(computers.content[0].text)["computers"]
        self.assertEqual([c["name"] for c in listed], ["Py-Test-PC"])
        self.assertTrue(listed[0]["online"])
        self.assertFalse(getattr(info, "is_error", getattr(info, "isError", None)))
        self.assertEqual(json.loads(info.content[0].text)["hostname"], "PY-TEST-PC")
        self.assertTrue(getattr(missing, "is_error", getattr(missing, "isError", None)))
        self.assertIn("No computer named nope", missing.content[0].text)

    def test_wrong_bearer_is_refused(self):
        with self.assertRaises(BaseException):
            asyncio.run(asyncio.wait_for(self._session("0" * 64), timeout=30))


if __name__ == "__main__":
    unittest.main()
