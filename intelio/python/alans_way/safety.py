"""Ask-first defaults for the Alan's Way fork. These never loosen a profile."""

from __future__ import annotations

import re
from urllib.parse import urlsplit

CONSEQUENTIAL_ACTIONS = (
    "external_message",
    "purchase",
    "credential_change",
    "permission_change",
    "production_change",
    "destructive",
)

_SECRET = (
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-+/=]+"),
    re.compile(r"(?i)\b(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S+"),
    re.compile(r"\bsk-[A-Za-z0-9]{8,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{10,}\b"),
)
_PURCHASE_HOSTS = ("paypal.com", "stripe.com")
_PATH_KIND = (
    (re.compile(r"(?:^|/)(?:checkout|payment|billing)(?:/|$)"), "purchase"),
    (re.compile(r"(?:^|/)(?:delete-account|destroy|drop-database)(?:/|$)"), "destructive"),
)


def redact(text: str) -> str:
    """Remove credential-shaped fragments. Safe to put in a UI or a log."""
    if not isinstance(text, str):
        return ""
    cleaned = text
    for pattern in _SECRET:
        cleaned = pattern.sub("[redacted]", cleaned)
    return cleaned


def enforce(safety) -> dict:
    """Return the standing defaults. YOLO and auto-approval are refused."""
    if safety is None:
        safety = {}
    if not isinstance(safety, dict):
        raise ValueError("safety must be a mapping")
    if safety.get("yolo") is True:
        raise ValueError("YOLO is not allowed")
    consequential = safety.get("consequential", "ask")
    if consequential != "ask":
        raise ValueError("consequential actions must stay ask-first")
    return {
        "yolo": False,
        "consequential": "ask",
        "vault_blind": True,
        "consequential_actions": list(CONSEQUENTIAL_ACTIONS),
    }


def classify_url(url: str):
    """Return a consequential kind, or None. Login pages are not classified."""
    if not isinstance(url, str) or not url:
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    host = (parts.hostname or "").casefold()
    if any(host == name or host.endswith("." + name) for name in _PURCHASE_HOSTS):
        return "purchase"
    path = (parts.path or "").casefold()
    for pattern, kind in _PATH_KIND:
        if pattern.search(path):
            return kind
    return None


def navigation_allowed(url: str, origins: list[str], app_pages: tuple[str, ...] = ()) -> bool:
    """Empty origins add no extra gate. A set list denies every other http(s) origin."""
    if url in app_pages:
        return True
    if not origins:
        return True
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        return False
    origin = f"{parts.scheme}://{parts.hostname}"
    if parts.port:
        origin += f":{parts.port}"
    return origin in origins
