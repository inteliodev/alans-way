"""Call the VPS filler. The model-facing result never includes a secret.

The multiplexed hermes-gateway switches profiles per message with
set_hermes_home_override. It does not set INTELIO_HERMES_PROFILE or
HERMES_PROFILE, and tool handlers are not given a profile name. This module
reads that per-message home (or hermes_cli.profiles.current_profile_name) and
refuses default, custom, and unknown. It never guesses "intelio".
"""
import json
import os
import urllib.request
from pathlib import Path

SCHEMA = {
    "name": "fill_saved_login",
    "description": (
        "Fill a saved login into the profile browser for a site domain. "
        "The password and one-time code stay in the profile vault and are not returned."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "site": {"type": "string", "description": "Site domain, such as portal.example.com"},
        },
        "required": ["site"],
    },
}

PUBLIC_KEYS = ("ok", "filled", "saved", "domain", "username", "error")
UNKNOWN = "Unknown profile."
REFUSED = frozenset({"default", "custom", "unknown"})


def public_result(payload):
    data = payload if isinstance(payload, dict) else {}
    out = {
        "ok": bool(data.get("ok")),
        "filled": bool(data.get("filled")),
        "domain": str(data.get("domain") or "")[:200],
        "username": str(data.get("username") or "")[:200],
    }
    if data.get("error"):
        out["error"] = str(data.get("error") or "")[:160]
    return {key: out[key] for key in PUBLIC_KEYS if key in out}


def _validate_profile(raw):
    name = str(raw or "").strip().lower()
    if (
        not name
        or name in REFUSED
        or len(name) > 32
        or not all(ch.isalnum() or ch in "-_" for ch in name)
    ):
        raise ValueError(UNKNOWN)
    return name


def profile_from_home(home):
    """Profile id is the directory name under profiles/, not a fallback."""
    path = Path(home).expanduser()
    if path.name == "" or path.parent.name != "profiles":
        raise ValueError(UNKNOWN)
    return _validate_profile(path.name)


def _override_home():
    try:
        from hermes_constants import get_hermes_home_override
    except ImportError:
        return None
    except Exception as exc:
        raise ValueError(UNKNOWN) from exc
    try:
        return get_hermes_home_override()
    except Exception as exc:
        raise ValueError(UNKNOWN) from exc


def _named_profile():
    try:
        from hermes_cli.profiles import current_profile_name
    except ImportError:
        return None
    except Exception as exc:
        raise ValueError(UNKNOWN) from exc
    try:
        try:
            name = current_profile_name(None)
        except TypeError:
            name = current_profile_name()
    except ValueError as exc:
        raise ValueError(UNKNOWN) from exc
    except Exception as exc:
        raise ValueError(UNKNOWN) from exc
    if name is None or str(name).strip() == "":
        return None
    return _validate_profile(name)


def active_profile():
    """Resolve the profile for this message. Raises ValueError(UNKNOWN) otherwise."""
    home = _override_home()
    if home:
        return profile_from_home(home)
    named = _named_profile()
    if named:
        return named
    raise ValueError(UNKNOWN)


def read_profile_key(profile, home=None):
    root = Path(home or os.environ.get("HOME") or ".")
    env_file = root / ".hermes" / "profiles" / profile / ".env"
    text = env_file.read_text(encoding="utf-8")
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("export "):
            stripped = stripped[7:].strip()
        if stripped.startswith("API_SERVER_KEY="):
            return stripped.split("=", 1)[1].strip().strip('"').strip("'")
    raise ValueError(UNKNOWN)


def fill_saved_login(args, **kwargs):
    """POST site + the active profile. Return JSON with no secret.

    kwargs from the gateway are task_id, session_id, enabled_tools, and
    user_task. A profile argument is ignored so one message cannot select
    another profile's key.
    """
    del kwargs
    try:
        site = str((args or {}).get("site") or "").strip()
        if not site:
            return json.dumps(public_result({"ok": False, "filled": False, "error": "Enter a site domain."}))
        profile = active_profile()
        key = read_profile_key(profile)
        origin = str(os.environ.get("INTELIO_FILLER_URL") or "http://127.0.0.1:8643").rstrip("/")
        url = origin + "/api/vault/fill"
        payload = json.dumps({"site": site, "profile": profile}).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=payload,
            method="POST",
            headers={
                "Authorization": "Bearer " + key,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "x-intelio-profile": profile,
            },
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read().decode("utf-8", "replace")
        return json.dumps(public_result(json.loads(raw)))
    except ValueError:
        return json.dumps(public_result({"ok": False, "filled": False, "error": UNKNOWN}))
    except Exception:
        return json.dumps(public_result({"ok": False, "filled": False, "error": "Filler did not run."}))
