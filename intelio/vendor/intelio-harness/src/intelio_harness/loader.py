"""Read a profile directory and the Hermes pin.

The pin is data this harness reads. Nothing here imports Hermes or copies
its tree. A missing profile.yaml or a missing pin file refuses startup.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

PIN_RELATIVE = Path("pin") / "hermes.yaml"
UPSTREAM = "NousResearch/hermes-agent"
REPOSITORY = "https://github.com/NousResearch/hermes-agent"
PROFILE_FIELDS = ("name", "panels", "skills", "allowed_folders")
PIN_FIELDS = ("upstream", "repository", "commit", "verified_on")
_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_DATE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")


class HarnessRefused(Exception):
    """The harness will not start."""


@dataclass(frozen=True)
class HermesPin:
    upstream: str
    repository: str
    commit: str
    verified_on: str
    path: Path


@dataclass(frozen=True)
class Profile:
    name: str
    panels: tuple[str, ...]
    skills: tuple[str, ...]
    allowed_folders: tuple[str, ...]
    directory: Path


def repo_root() -> Path:
    """Return the harness checkout that contains this module."""
    return Path(__file__).resolve().parents[2]


def default_pin_path() -> Path:
    """Find pin/hermes.yaml from this install, or the path where it should live."""
    starts = [Path(__file__).resolve().parent, Path.cwd()]
    seen: set[Path] = set()
    for start in starts:
        for directory in [start, *start.parents]:
            if directory in seen:
                continue
            seen.add(directory)
            candidate = directory / PIN_RELATIVE
            if candidate.is_file():
                return candidate
    return repo_root() / PIN_RELATIVE


def load_profile(profile_dir: Path, pin_path: Path | None = None) -> tuple[Profile, HermesPin]:
    """Load one profile. Refuse when profile.yaml or the pin file is missing."""
    pin = load_pin(default_pin_path() if pin_path is None else pin_path)
    profile_file = Path(profile_dir) / "profile.yaml"
    if not profile_file.is_file():
        raise HarnessRefused(f"profile.yaml is missing: {profile_file}")
    data = _read_mapping(profile_file, "profile.yaml")
    _reject_unknown(data, PROFILE_FIELDS, profile_file)
    return (
        Profile(
            name=_required_string(data, "name", profile_file),
            panels=_string_list(data, "panels", profile_file),
            skills=_string_list(data, "skills", profile_file),
            allowed_folders=_allowed_folders(data, profile_file),
            directory=Path(profile_dir),
        ),
        pin,
    )


def load_pin(path: Path) -> HermesPin:
    """Read the upstream pin. Refuse when the file is missing or incomplete."""
    if not path.is_file():
        raise HarnessRefused(f"pin file is missing: {path}")
    data = _read_mapping(path, "pin file")
    _reject_unknown(data, PIN_FIELDS, path)
    upstream = _required_string(data, "upstream", path)
    repository = _required_string(data, "repository", path)
    commit = _required_string(data, "commit", path)
    verified_on = _required_string(data, "verified_on", path)
    if upstream != UPSTREAM:
        raise HarnessRefused(f"pin upstream must be {UPSTREAM}: {path}")
    if repository != REPOSITORY:
        raise HarnessRefused(f"pin repository must be {REPOSITORY}: {path}")
    if _COMMIT.fullmatch(commit) is None:
        raise HarnessRefused(f"pin commit must be a 40-character SHA: {path}")
    if _DATE.fullmatch(verified_on) is None:
        raise HarnessRefused(f"pin verified_on must be YYYY-MM-DD: {path}")
    return HermesPin(
        upstream=upstream,
        repository=repository,
        commit=commit,
        verified_on=verified_on,
        path=path,
    )


def _read_mapping(path: Path, label: str) -> dict:
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise HarnessRefused(f"{label} is not valid YAML: {path}") from exc
    if not isinstance(loaded, dict):
        raise HarnessRefused(f"{label} must be a mapping: {path}")
    return loaded


def _reject_unknown(data: dict, allowed: tuple[str, ...], path: Path) -> None:
    unknown = sorted(set(data) - set(allowed))
    if unknown:
        names = ", ".join(unknown)
        raise HarnessRefused(f"unknown fields ({names}): {path}")


def _required_string(data: dict, key: str, path: Path) -> str:
    value = data.get(key)
    if not isinstance(value, str) or value.strip() == "" or value != value.strip():
        raise HarnessRefused(f"{key} must be a non-empty string: {path}")
    return value


def _string_list(data: dict, key: str, path: Path) -> tuple[str, ...]:
    value = data.get(key)
    if not isinstance(value, list):
        raise HarnessRefused(f"{key} must be a list of strings: {path}")
    items: list[str] = []
    for item in value:
        if not isinstance(item, str) or item.strip() == "" or item != item.strip():
            raise HarnessRefused(f"{key} must be a list of non-empty strings: {path}")
        items.append(item)
    return tuple(items)


def _allowed_folders(data: dict, path: Path) -> tuple[str, ...]:
    folders = _string_list(data, "allowed_folders", path)
    for folder in folders:
        if _is_machine_path(folder):
            raise HarnessRefused(
                f"allowed_folders must be relative folder names, not machine paths: {folder}"
            )
    return folders


def _is_machine_path(folder: str) -> bool:
    if folder in {".", ".."}:
        return True
    if folder.startswith(("/", "\\")) or "\\" in folder or ":" in folder:
        return True
    return ".." in Path(folder).parts
