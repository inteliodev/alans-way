"""Read the Hermes pin and compare it with an installed hermes binary."""

from __future__ import annotations

import os
import re
import shutil
import subprocess

from .safety import redact
from .yaml_subset import YamlError, parse_yaml_subset

_SHA = re.compile(r"\b([0-9a-f]{40})\b")
_PROFILE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def read_pin(path) -> dict:
    text = path.read_text(encoding="utf-8")
    if len(text) > 8192:
        raise ValueError("refusing to start: Hermes pin is invalid")
    try:
        data = parse_yaml_subset(text)
    except YamlError:
        raise ValueError("refusing to start: Hermes pin is invalid") from None
    if not isinstance(data, dict):
        raise ValueError("refusing to start: Hermes pin is invalid")
    commit = data.get("commit")
    upstream = data.get("upstream")
    repository = data.get("repository")
    if (upstream != "NousResearch/hermes-agent"
            or not isinstance(repository, str) or not repository.startswith("https://github.com/NousResearch/hermes-agent")
            or not isinstance(commit, str) or re.fullmatch(r"[0-9a-f]{40}", commit) is None):
        raise ValueError("refusing to start: Hermes pin is invalid")
    sync_status = data.get("sync_status")
    if sync_status is not None and (not isinstance(sync_status, str) or len(sync_status) > 40):
        raise ValueError("refusing to start: Hermes pin is invalid")
    return {
        "upstream": upstream,
        "repository": repository,
        "commit": commit,
        "sync_status": sync_status or "",
    }


def launch_argv(hermes_profile: str) -> list[str]:
    if hermes_profile:
        if _PROFILE.fullmatch(hermes_profile) is None:
            raise ValueError("refusing to start: hermes_profile is invalid")
        return ["hermes", "-p", hermes_profile]
    return ["hermes"]


def probe_hermes(hermes_profile: str, environ: dict | None = None) -> dict:
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
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=8, check=False, env=env,
        )
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
    pin_commit = None  # filled by the caller for the match decision
    base["version"] = redact(stdout.strip())[:500]
    base["commit"] = found[0] if found else None
    base["command_ok"] = True
    base["error"] = None
    base["_found"] = found
    base["pin_compare_pending"] = pin_commit
    return base


def finish_probe(probe: dict, pin_commit: str) -> dict:
    """Compare a successful probe to the pin. Failures stay failures."""
    found = probe.pop("_found", [])
    probe.pop("pin_compare_pending", None)
    if not probe.get("command_ok"):
        probe["match"] = "unavailable"
        return probe
    if pin_commit in found:
        probe["match"] = "commit"
        probe["commit"] = pin_commit
        probe["summary"] = "installed commit matches the pin"
        return probe
    if found:
        probe["match"] = "differs"
        probe["commit"] = found[0]
        probe["summary"] = "installed Hermes does not match the pin"
        return probe
    probe["match"] = "unverified"
    probe["commit"] = None
    probe["summary"] = "Hermes responded, but the output has no commit to compare with the pin"
    return probe
