"""Check tracked files before publication; findings never echo matched secrets.

This is a conservative repository policy check, not a complete secret detector.
Run after git add and before committing/pushing. CI runs it on a clean checkout.
"""
from __future__ import annotations

import ast
import ipaddress
from pathlib import Path
import re
import stat
import subprocess
import sys

RULES = (
    ("private-key", re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----")),
    ("github-credential", re.compile(r"(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}")),
    ("personal-home-path", re.compile(
        "/" + r"Users/(?!user/|macuser/|your-name/|you/)[^/\s'\"<>]+/"
        + "|/" + r"home/(?!user/|macuser/|your-name/|you/)[^/\s'\"<>]+/")),
)
IPV4 = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])")
TAILNET = ipaddress.ip_network((0x64400000, 10))
EXAMPLE_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    (0xC0000200, 24), (0xC6336400, 24), (0xCB007100, 24),
))
FORBIDDEN_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".pem", ".key", ".patch", ".diff", ".log"}
FORBIDDEN_IMPORTS = {"gateway", "tui_gateway", "hermes_cli", "hermes_state", "run_agent", "model_tools", "tools", "agent"}
BINARY_ASSETS = {"desktop/assets/icon.png": b"\x89PNG\r\n\x1a\n", "desktop/assets/icon.icns": b"icns",
                 "desktop/src/newtab-backdrop.png": b"\x89PNG\r\n\x1a\n",
                 "desktop/src/fonts/geist-sans-latin-400-normal.woff2": b"wOF2"}
AVATAR_ASSETS = frozenset(f"desktop/assets/avatars/{name}.png" for name in (
    "apollo", "artemis", "athena", "faun", "hades", "hermes", "medusa",
    "minotaur", "poseidon", "zeus",
))
BINARY_ASSETS.update({name: b"\x89PNG\r\n\x1a\n" for name in AVATAR_ASSETS})
BINARY_LIMITS = {"desktop/src/newtab-backdrop.png": 4194304, "desktop/assets/icon.icns": 2097152}


def valid_binary_asset(path: str, blob: bytes) -> bool:
    signature = BINARY_ASSETS.get(path)
    limit = BINARY_LIMITS.get(path, 2097152 if path in AVATAR_ASSETS else 1048576)
    return bool(signature and blob.startswith(signature) and len(blob) <= limit)


def inspect_text(path: str, text: str) -> list[dict]:
    """Return locations/rule labels only, never matching text or secret values."""
    name = Path(path).name.casefold()
    findings = []
    if (Path(path).suffix.casefold() in FORBIDDEN_SUFFIXES
            or name == ".env" or name.startswith(".env.")
            or name in {"credentials.json", "auth.json", "tokens.json"}):
        findings.append({"file": path, "line": 0, "rule": "runtime-or-private-artifact"})
    for number, line in enumerate(text.splitlines(), 1):
        for label, pattern in RULES:
            if pattern.search(line):
                findings.append({"file": path, "line": number, "rule": label})
        for match in IPV4.finditer(line):
            try:
                address = ipaddress.ip_address(match.group())
            except ValueError:
                continue
            if address.is_loopback or any(address in network for network in EXAMPLE_NETWORKS):
                continue
            if address.is_private or address in TAILNET:
                findings.append({"file": path, "line": number, "rule": "private-device-address"})
    if path.startswith("src/") and path.endswith(".py"):
        try:
            tree = ast.parse(text)
        except SyntaxError:
            findings.append({"file": path, "line": 0, "rule": "python-syntax"})
        else:
            for node in ast.walk(tree):
                modules = []
                if isinstance(node, ast.Import):
                    modules = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    modules = [node.module or ""]
                if any(module.split(".")[0] in FORBIDDEN_IMPORTS for module in modules):
                    findings.append({"file": path, "line": getattr(node, "lineno", 0), "rule": "private-hermes-import"})
    return findings


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True, check=True)
    paths = [value.decode("utf-8") for value in result.stdout.split(b"\x00") if value]
    if not paths:
        print("Publication check refused: no tracked files.", file=sys.stderr)
        return 1
    findings = []
    for path in paths:
        item = root / path
        mode = item.lstat().st_mode
        if not stat.S_ISREG(mode):
            findings.append({"file": path, "line": 0, "rule": "nonregular-file"})
            continue
        if path in BINARY_ASSETS:
            blob = item.read_bytes()
            if not valid_binary_asset(path, blob):
                findings.append({"file": path, "line": 0, "rule": "invalid-static-asset"})
            continue
        try:
            text = item.read_text(encoding="utf-8")
        except (UnicodeError, OSError):
            findings.append({"file": path, "line": 0, "rule": "unreadable-or-binary"})
            continue
        findings.extend(inspect_text(path, text))
    for finding in findings:
        print(f"{finding['file']}:{finding['line']}: {finding['rule']}", file=sys.stderr)
    if findings:
        print(f"Publication check failed: {len(findings)} finding(s).", file=sys.stderr)
        return 1
    print(f"Publication policy passed for {len(paths)} tracked files. Not a complete secret audit.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
