"""Command line entry for the profile loader."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from intelio_harness.loader import HarnessRefused, HermesPin, Profile, load_profile


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="intelio-harness",
        description=(
            "Load an Intelio profile and the Hermes pin. "
            "Refuses to start when profile.yaml or the pin file is missing."
        ),
    )
    parser.add_argument(
        "profile_dir",
        type=Path,
        help="Profile directory that contains profile.yaml",
    )
    parser.add_argument(
        "--pin",
        type=Path,
        default=None,
        help="Path to pin/hermes.yaml. Defaults to the pin shipped with this harness.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print the loaded profile and Hermes pin as JSON.",
    )
    args = parser.parse_args(argv)
    try:
        profile, pin = load_profile(args.profile_dir, args.pin)
    except HarnessRefused as exc:
        print(f"intelio-harness: refused to start: {exc}", file=sys.stderr)
        return 1
    if args.json:
        json.dump(_payload(profile, pin), sys.stdout)
        sys.stdout.write("\n")
        return 0
    print(f"profile: {profile.name}")
    print(f"panels: {_join(profile.panels)}")
    print(f"skills: {_join(profile.skills)}")
    print(f"allowed_folders: {_join(profile.allowed_folders)}")
    print(f"hermes_commit: {pin.commit}")
    return 0


def console_main() -> None:
    raise SystemExit(main())


def _join(items: tuple[str, ...]) -> str:
    return ", ".join(items)


def _payload(profile: Profile, pin: HermesPin) -> dict:
    return {
        "profile": {
            "name": profile.name,
            "panels": list(profile.panels),
            "skills": list(profile.skills),
            "allowed_folders": list(profile.allowed_folders),
            "directory": str(profile.directory.resolve()),
        },
        "pin": {
            "upstream": pin.upstream,
            "repository": pin.repository,
            "commit": pin.commit,
            "verified_on": pin.verified_on,
        },
    }
