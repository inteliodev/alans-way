"""Bound local file reads to a profile's allowed_folders."""

from __future__ import annotations

from pathlib import Path

VAULT_NAMES = {".env", "env"}
VAULT_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".kdbx"}


class FileBound(PermissionError):
    """A path is outside the profile or looks like a vault file."""


def ensure_allowed(path: Path, allowed_folders: list[str]) -> Path:
    """Resolve path and require it to sit inside one allowed folder."""
    try:
        resolved = Path(path).resolve()
    except (OSError, RuntimeError):
        raise FileBound("path is outside allowed_folders") from None
    for folder in allowed_folders:
        root = Path(folder).resolve()
        if resolved == root or root in resolved.parents:
            return resolved
    raise FileBound("path is outside allowed_folders")


def read_text(relative: str, allowed_folders: list[str], folder: str) -> str:
    """Read one UTF-8 text file inside an allowed folder. Never reads a vault file."""
    if not isinstance(relative, str) or not relative or relative.startswith("/") or "\\" in relative:
        raise FileBound("path is outside allowed_folders")
    parts = relative.split("/")
    if any(part in ("", ".", "..") or part.startswith(".") for part in parts):
        raise FileBound("path is outside allowed_folders")
    name = parts[-1].casefold()
    if name in VAULT_NAMES or name.startswith(".env") or name.endswith(tuple(VAULT_SUFFIXES)):
        raise FileBound("vault files are not readable")
    if str(Path(folder).resolve()) not in {str(Path(item).resolve()) for item in allowed_folders}:
        raise FileBound("path is outside allowed_folders")
    target = ensure_allowed(Path(folder) / relative, allowed_folders)
    if target.is_symlink() or not target.is_file():
        raise FileBound("path is outside allowed_folders")
    data = target.read_bytes()
    if len(data) > 65536:
        raise FileBound("file is outside the read bound")
    try:
        return data.decode("utf-8")
    except UnicodeError:
        raise FileBound("file is outside the read bound") from None
