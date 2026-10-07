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
from urllib.parse import urlparse

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
FILLER_URL = "Filler URL is not configured."
REFUSED = frozenset({"default", "custom", "unknown"})
FIXED_ERRORS = frozenset({UNKNOWN, FILLER_URL})


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


def _env_file_map(path):
    values = {}
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return values
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[7:].strip()
        if "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _check_origin(origin):
    parsed = urlparse(str(origin or "").strip())
    host = parsed.hostname or ""
    if parsed.scheme not in ("http", "https") or not host or parsed.username or parsed.password:
        raise ValueError(FILLER_URL)
    if host in {"0.0.0.0", "::"} or host == "*":
        raise ValueError(FILLER_URL)
    if ":" in host:
        host = f"[{host}]"
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{host}{port}"


def filler_origin(env=None, env_file=None):
    """PWA origin. https when pwa.env has a cert and key; never loopback by default.

    INTELIO_FILLER_URL wins. Otherwise read ~/.config/intelio/pwa.env
    (INTELIO_PWA_BIND, INTELIO_PWA_PORT, INTELIO_PWA_CERT, INTELIO_PWA_KEY).
    The phone client listens on the tailnet host with Tailscale TLS.
    A missing bind is an error; there is no loopback fallback.
    """
    env = os.environ if env is None else env
    explicit = str(env.get("INTELIO_FILLER_URL") or "").strip()
    if explicit:
        return _check_origin(explicit)
    path = env_file or env.get("INTELIO_PWA_ENV") or str(
        Path(env.get("HOME") or ".") / ".config" / "intelio" / "pwa.env"
    )
    values = _env_file_map(path)
    bind = str(values.get("INTELIO_PWA_BIND") or env.get("INTELIO_PWA_BIND") or "").strip()
    port = str(values.get("INTELIO_PWA_PORT") or env.get("INTELIO_PWA_PORT") or "8643").strip()
    cert = str(values.get("INTELIO_PWA_CERT") or env.get("INTELIO_PWA_CERT") or "").strip()
    key = str(values.get("INTELIO_PWA_KEY") or env.get("INTELIO_PWA_KEY") or "").strip()
    if not bind or not port.isdigit() or not 1 <= int(port) <= 65535:
        raise ValueError(FILLER_URL)
    if "://" in bind or "/" in bind or "@" in bind or " " in bind:
        raise ValueError(FILLER_URL)
    if bool(cert) != bool(key):
        raise ValueError(FILLER_URL)
    scheme = "https" if cert and key else "http"
    return _check_origin(f"{scheme}://{bind}:{port}")


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
        origin = filler_origin()
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
    except ValueError as exc:
        message = str(exc) if str(exc) in FIXED_ERRORS else UNKNOWN
        return json.dumps(public_result({"ok": False, "filled": False, "error": message}))
    except Exception:
        return json.dumps(public_result({"ok": False, "filled": False, "error": "Filler did not run."}))
