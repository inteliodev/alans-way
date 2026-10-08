"""Compare an installed hermes binary with a pin commit from the real loader."""

from __future__ import annotations

import os
import re
import shutil
import subprocess

from alans_way.safety import redact

_SHA = re.compile(r"\b([0-9a-f]{40})\b")
_UPSTREAM_SHA = re.compile(r"\bupstream\s+([0-9a-f]{7,40})\b")
_DESCRIBE_SHA = re.compile(r"\+\d+\.g([0-9a-f]{7,40})\b")
_LOCAL_SHA = re.compile(r"\blocal\s+([0-9a-f]{7,40})\b")
_PROFILE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def installed_sha(text: str) -> str | None:
    """Pull a commit from `upstream <sha>` or a `+N.g<sha>` describe suffix.

    A full 40-character SHA still counts. When both forms are present and one
    extends the other, the longer one is kept.
    """
    if not isinstance(text, str) or not text:
        return None
    lowered = text.lower()
    candidates = _UPSTREAM_SHA.findall(lowered) + _DESCRIBE_SHA.findall(lowered) + _SHA.findall(lowered)
    chosen = ""
    for item in candidates:
        if not chosen:
            chosen = item
            continue
        if item.startswith(chosen) or chosen.startswith(item):
            if len(item) > len(chosen):
                chosen = item
            continue
        if len(chosen) == 40:
            continue
        if len(item) == 40:
            chosen = item
    return chosen or None


def matches_pin(pin_commit: str, found: str) -> bool:
    """True when the installed SHA is the pin or a prefix of it (or the reverse)."""
    if not isinstance(pin_commit, str) or not isinstance(found, str):
        return False
    pin = pin_commit.lower()
    short = found.lower()
    if _SHA.fullmatch(pin) is None or re.fullmatch(r"[0-9a-f]{7,40}", short) is None:
        return False
    return pin.startswith(short) or short.startswith(pin)


def pinned_head(text: str, pin_commit: str) -> str | None:
    """The running head when it is the pinned commit, else None.

    The pin is a fork build (inteliodev/hermes-agent). Hermes prints
    `upstream <origin/main> · local <HEAD> (+N carried commits)` for a fork
    checkout, and often a `+N.g<HEAD>` describe suffix. `upstream` is
    whatever origin/main is on that host, so when a `local` head is printed
    only that head counts; otherwise the describe suffix, `upstream`, or a
    full SHA may name the running commit.
    """
    if not isinstance(text, str) or not text:
        return None
    lowered = text.lower()
    tokens = _LOCAL_SHA.findall(lowered) or (
        _DESCRIBE_SHA.findall(lowered) + _UPSTREAM_SHA.findall(lowered) + _SHA.findall(lowered))
    for token in tokens:
        if matches_pin(pin_commit, token):
            return token
    return None


def launch_argv(hermes_profile: str) -> list[str]:
    if hermes_profile:
        if _PROFILE.fullmatch(hermes_profile) is None:
            raise ValueError("hermes_profile is invalid")
        return ["hermes", "-p", hermes_profile]
    return ["hermes"]


def probe_hermes(hermes_profile: str, pin_commit: str, environ: dict | None = None) -> dict:
    """Run hermes (-p name) --version. A failed process is never a match."""
    env = environ if environ is not None else os.environ
    argv = launch_argv(hermes_profile) + ["--version"]
    base = {
        "launch_argv": launch_argv(hermes_profile),
        "probe_argv": argv,
        "present": False,
        "command_ok": False,
        "exit_code": None,
        "version": None,
        "commit": None,
        "match": "unavailable",
        "error": "hermes not on PATH",
        "summary": "not on PATH",
    }
    exe = shutil.which("hermes", path=env.get("PATH", ""))
    if not exe:
        return base
    base["present"] = True
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=8, check=False, env=env)
    except subprocess.TimeoutExpired:
        base["error"] = "probe timed out"
        base["summary"] = "probe timed out"
        return base
    except OSError:
        base["error"] = "probe could not start"
        base["summary"] = "probe could not start"
        return base
    stdout = proc.stdout or ""
    stderr = proc.stderr or ""
    base["exit_code"] = proc.returncode
    if proc.returncode != 0:
        base["error"] = redact(stderr.strip())[:300] or f"probe failed (exit {proc.returncode})"
        base["summary"] = f"probe failed (exit {proc.returncode})"
        return base
    # A fork checkout's running build is its `local` head, not origin/main.
    local = _LOCAL_SHA.findall(stdout.lower())
    found = local[0] if local else installed_sha(stdout)
    base["version"] = redact(stdout.strip())[:500]
    base["command_ok"] = True
    base["error"] = None
    if pinned_head(stdout, pin_commit):
        base["match"] = "commit"
        base["commit"] = pin_commit
        base["summary"] = "installed commit matches the pin"
        return base
    if found:
        base["match"] = "differs"
        base["commit"] = found
        base["summary"] = f"installed {found} vs pin {pin_commit[:8]}"
        return base
    base["match"] = "unverified"
    base["summary"] = "Hermes responded, but the output has no commit to compare with the pin"
    return base
