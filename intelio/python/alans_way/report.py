"""Build the desktop report from the real harness loader plus the fork sidecar."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlsplit

import yaml

from alans_way.probe import probe_hermes
from alans_way.safety import enforce
from intelio_harness.loader import HarnessRefused, load_profile, repo_root

SIDECAR_FIELDS = ("hermes_profile", "browsing_origins", "safety")
# Colors are the ones the harness README states. The export has no palette file.
BRAND_TOKENS = {
    "background": "#0a0a0a",
    "foreground": "#ffffff",
    "surface": "#f5f5f5",
    "line": "#e5e5e5",
    "font": "Geist",
}
ATTRIBUTION = "Alan's Way by Alex Hansen. Hermes Agent by Nous Research."


class ForkRefusal(Exception):
    """The fork will not treat this profile as loaded."""

    def __init__(self, message: str):
        super().__init__(message)
        self.code = 1


def load_report(profile_dir, pin_path=None, environ=None) -> dict:
    """Load profile.yaml with intelio_harness, then apply alans-way.yaml if present."""
    directory = Path(profile_dir)
    try:
        profile, pin = load_profile(directory, pin_path)
    except HarnessRefused as exc:
        raise ForkRefusal(str(exc)) from None
    sidecar = _read_sidecar(directory / "alans-way.yaml")
    try:
        safety = enforce(sidecar.get("safety"))
        hermes_profile = _hermes_profile(sidecar.get("hermes_profile", ""))
        origins = _normalize_origins(sidecar.get("browsing_origins", []))
        hermes = probe_hermes(hermes_profile, pin.commit, environ)
    except ValueError as exc:
        raise ForkRefusal(str(exc)) from None
    brand = _brand(repo_root())
    return {
        "ok": True,
        "profile_dir": str(directory.resolve()),
        "profile": {
            "name": profile.name,
            "panels": list(profile.panels),
            "skills": list(profile.skills),
            "allowed_folders": list(profile.allowed_folders),
            "hermes_profile": hermes_profile,
            "browsing_origins": origins,
        },
        "safety": safety,
        "brand": brand,
        "pin": {
            "upstream": pin.upstream,
            "repository": pin.repository,
            "commit": pin.commit,
            "verified_on": pin.verified_on,
        },
        "hermes": hermes,
        "secrets_file_present": (directory / ".env").is_file(),
        "attribution": ATTRIBUTION,
    }


def _read_sidecar(path: Path) -> dict:
    if not path.exists():
        return {}
    if path.is_symlink() or not path.is_file():
        raise ForkRefusal("alans-way.yaml is missing")
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError:
        raise ForkRefusal("alans-way.yaml is not valid") from None
    if loaded is None:
        return {}
    if not isinstance(loaded, dict):
        raise ForkRefusal("alans-way.yaml must be a mapping")
    unknown = sorted(set(loaded) - set(SIDECAR_FIELDS))
    if unknown:
        raise ForkRefusal("alans-way.yaml has unknown fields")
    return loaded


def _hermes_profile(value) -> str:
    if value is None:
        return ""
    if not isinstance(value, str) or value != value.strip():
        raise ForkRefusal("hermes_profile is invalid")
    return value


def _normalize_origins(raw) -> list[str]:
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        raise ForkRefusal("browsing_origins is invalid")
    origins = []
    for item in raw:
        if not isinstance(item, str):
            raise ForkRefusal("browsing_origins is invalid")
        parts = urlsplit(item.strip())
        if (parts.scheme not in ("http", "https") or not parts.hostname
                or parts.username or parts.password or parts.query or parts.fragment
                or parts.path not in ("", "/")):
            raise ForkRefusal("browsing_origins must be http(s) origins")
        origin = f"{parts.scheme}://{parts.hostname}"
        if parts.port:
            origin += f":{parts.port}"
        origins.append(origin)
    return origins


def _brand(root: Path) -> dict:
    title_path = root / "brand" / "window-title.txt"
    icon_path = root / "brand" / "icon.svg"
    if not title_path.is_file() or title_path.is_symlink() or not icon_path.is_file() or icon_path.is_symlink():
        raise ForkRefusal("brand files are missing")
    title = title_path.read_text(encoding="utf-8").strip()
    svg = icon_path.read_text(encoding="utf-8").strip()
    lowered = svg.casefold()
    if (not title or len(title) > 80 or not lowered.startswith("<svg") or "</svg>" not in lowered
            or "<script" in lowered or "javascript:" in lowered or "onload=" in lowered):
        raise ForkRefusal("brand files are invalid")
    return {"window_title": title, "tokens": dict(BRAND_TOKENS), "icon_svg": svg}
