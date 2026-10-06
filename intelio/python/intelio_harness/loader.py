"""Load one Intelio profile directory and the vendored harness contract."""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlsplit

from .files import ensure_allowed
from .pin import finish_probe, probe_hermes, read_pin
from .safety import enforce, redact
from .schema import SchemaError, validate
from .yaml_subset import YamlError, parse_yaml_subset

ATTRIBUTION = "Alan's Way by Alex Hansen. Hermes Agent by Nous Research."
_MAX_PROFILE_BYTES = 65536


class Refusal(Exception):
    """The loader will not start. code 2 means a required file is missing."""

    def __init__(self, message: str, code: int = 1):
        super().__init__(message)
        self.code = code


def vendor_root() -> Path:
    return Path(__file__).resolve().parents[2] / "vendor" / "intelio-harness"


def _read_regular(path: Path, limit: int) -> str:
    if path.is_symlink() or not path.is_file():
        raise Refusal("refusing to start: a required file is missing", 2)
    data = path.read_bytes()
    if len(data) > limit:
        raise Refusal("refusing to start: a required file is invalid")
    try:
        return data.decode("utf-8")
    except UnicodeError:
        raise Refusal("refusing to start: a required file is invalid") from None


def _resolve_folders(profile_dir: Path, raw) -> list[str]:
    if not isinstance(raw, list):
        raise Refusal("refusing to start: profile.yaml is not valid")
    root = profile_dir.resolve()
    resolved = []
    for item in raw:
        if not isinstance(item, str) or not item or "\x00" in item or len(item) > 1024:
            raise Refusal("refusing to start: allowed_folders is invalid")
        candidate = Path(item)
        if not candidate.is_absolute():
            if any(part == ".." for part in candidate.parts):
                raise Refusal("refusing to start: allowed_folders is invalid")
            candidate = root / candidate
        if candidate.is_symlink() or not candidate.is_dir():
            raise Refusal("refusing to start: allowed_folders must be existing directories")
        real = candidate.resolve()
        if not Path(item).is_absolute() and root != real and root not in real.parents:
            raise Refusal("refusing to start: allowed_folders is invalid")
        resolved.append(str(real))
    return resolved


def _normalize_origins(raw) -> list[str]:
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        raise Refusal("refusing to start: browsing_origins is invalid")
    origins = []
    for item in raw:
        if not isinstance(item, str):
            raise Refusal("refusing to start: browsing_origins is invalid")
        parts = urlsplit(item.strip())
        if (parts.scheme not in ("http", "https") or not parts.hostname
                or parts.username or parts.password or parts.query or parts.fragment
                or parts.path not in ("", "/")):
            raise Refusal("refusing to start: browsing_origins must be http(s) origins")
        origin = f"{parts.scheme}://{parts.hostname}"
        if parts.port:
            origin += f":{parts.port}"
        origins.append(origin)
    return origins


def _load_brand(vendor: Path) -> dict:
    brand = vendor / "brand"
    title_path = brand / "window-title.txt"
    tokens_path = brand / "palette.json"
    icon_path = brand / "icon.svg"
    for required in (title_path, tokens_path, icon_path):
        if not required.is_file():
            raise Refusal("refusing to start: brand files are missing", 2)
    title = _read_regular(title_path, 200).strip()
    if not title or any(ord(char) < 32 for char in title) or len(title) > 40:
        raise Refusal("refusing to start: brand files are invalid")
    try:
        tokens = json.loads(_read_regular(tokens_path, 4096))
    except json.JSONDecodeError:
        raise Refusal("refusing to start: brand files are invalid") from None
    expected = {
        "background": "#0a0a0a",
        "foreground": "#ffffff",
        "surface": "#f5f5f5",
        "line": "#e5e5e5",
        "font": "Geist",
    }
    if tokens != expected:
        raise Refusal("refusing to start: brand tokens do not match the Intelio palette")
    svg = _read_regular(icon_path, 32768).strip()
    lowered = svg.casefold()
    if (not lowered.startswith("<svg") or "</svg>" not in lowered or "<script" in lowered
            or "javascript:" in lowered or "onload=" in lowered):
        raise Refusal("refusing to start: brand icon is invalid")
    return {"window_title": title, "tokens": tokens, "icon_svg": svg}


def load_profile(profile_dir, vendor_dir=None, environ=None) -> dict:
    """Load a profile. Raises Refusal instead of returning a fake success."""
    directory = Path(profile_dir)
    if directory.is_symlink() or not directory.is_dir():
        raise Refusal("refusing to start: profile directory is missing", 2)
    profile_path = directory / "profile.yaml"
    if not profile_path.is_file():
        raise Refusal("refusing to start: profile.yaml is missing", 2)
    vendor = Path(vendor_dir) if vendor_dir else vendor_root()
    pin_path = vendor / "pin" / "hermes.yaml"
    schema_path = vendor / "schema" / "profile.schema.json"
    if not pin_path.is_file():
        raise Refusal("refusing to start: Hermes pin is missing", 2)
    if not schema_path.is_file():
        raise Refusal("refusing to start: profile schema is missing", 2)
    try:
        document = parse_yaml_subset(_read_regular(profile_path, _MAX_PROFILE_BYTES))
    except YamlError:
        raise Refusal("refusing to start: profile.yaml is not valid") from None
    if not isinstance(document, dict):
        raise Refusal("refusing to start: profile.yaml is not valid")
    # Standing rules are checked before the schema so a loosened schema cannot
    # turn YOLO or auto-approval into a successful load.
    safety_block = document.get("safety")
    if isinstance(safety_block, dict) and safety_block.get("yolo") is True:
        raise Refusal("refusing to start: YOLO is not allowed")
    if isinstance(safety_block, dict) and "consequential" in safety_block and safety_block.get("consequential") != "ask":
        raise Refusal("refusing to start: consequential actions must stay ask-first")
    try:
        schema = json.loads(_read_regular(schema_path, 65536))
        validate(document, schema)
    except (SchemaError, json.JSONDecodeError):
        raise Refusal("refusing to start: profile.yaml is not valid") from None
    try:
        safety = enforce(document.get("safety"))
    except ValueError as exc:
        raise Refusal(str(exc)) from None
    folders = _resolve_folders(directory, document.get("allowed_folders"))
    origins = _normalize_origins(document.get("browsing_origins"))
    hermes_profile = document.get("hermes_profile") or ""
    if not isinstance(hermes_profile, str):
        raise Refusal("refusing to start: profile.yaml is not valid")
    brand = _load_brand(vendor)
    try:
        pin = read_pin(pin_path)
        hermes = finish_probe(probe_hermes(hermes_profile, environ), pin["commit"])
    except ValueError as exc:
        raise Refusal(str(exc)) from None
    # Touch each allowed folder through the same bound local reads will use.
    for folder in folders:
        ensure_allowed(folder, folders)
    secrets = (directory / ".env").is_file()
    return {
        "ok": True,
        "profile_dir": str(directory.resolve()),
        "profile": {
            "name": document["name"],
            "panels": list(document.get("panels") or []),
            "skills": list(document.get("skills") or []),
            "allowed_folders": folders,
            "hermes_profile": hermes_profile,
            "browsing_origins": origins,
        },
        "safety": safety,
        "brand": brand,
        "pin": pin,
        "hermes": hermes,
        "secrets_file_present": secrets,
        "attribution": ATTRIBUTION,
    }


def public_report(report: dict) -> dict:
    """JSON-ready report. The loader never puts .env contents on this object."""
    return dict(report)


def redact_error(text: str) -> str:
    return redact(text)[:300]
