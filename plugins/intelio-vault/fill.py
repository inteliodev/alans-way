"""Call the VPS filler. The model-facing result never includes a secret."""
import json
import os
import urllib.error
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


def profile_name(explicit=""):
    raw = str(explicit or os.environ.get("INTELIO_HERMES_PROFILE") or os.environ.get("HERMES_PROFILE") or "intelio")
    name = raw.strip().lower()
    if not name or len(name) > 32 or not all(ch.isalnum() or ch in "-_" for ch in name) or name == "default":
        raise ValueError("Unknown profile.")
    return name


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
    raise ValueError("Profile key is not available.")


def fill_saved_login(args, **kwargs):
    """POST site + profile to the filler. Return JSON with no secret."""
    try:
        site = str((args or {}).get("site") or "").strip()
        if not site:
            return json.dumps(public_result({"ok": False, "filled": False, "error": "Enter a site domain."}))
        profile = profile_name(kwargs.get("profile") or "")
        home = kwargs.get("home")
        key = read_profile_key(profile, home)
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
    except Exception:
        return json.dumps(public_result({"ok": False, "filled": False, "error": "Filler did not run."}))
