"""Compare an installed hermes binary with a pin commit from the real loader."""

from __future__ import annotations

import os
import re
import shutil
import subprocess

from alans_way.safety import redact

_SHA = re.compile(r"\b([0-9a-f]{40})\b")
_PROFILE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


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
    found = _SHA.findall(stdout)
    base["version"] = redact(stdout.strip())[:500]
    base["command_ok"] = True
    base["error"] = None
    if pin_commit in found:
        base["match"] = "commit"
        base["commit"] = pin_commit
        base["summary"] = "installed commit matches the pin"
        return base
    if found:
        base["match"] = "differs"
        base["commit"] = found[0]
        base["summary"] = "installed Hermes does not match the pin"
        return base
    base["match"] = "unverified"
    base["summary"] = "Hermes responded, but the output has no commit to compare with the pin"
    return base
