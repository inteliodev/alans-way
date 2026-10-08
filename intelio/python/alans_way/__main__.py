"""python -m alans_way <profile_dir>

Loads the profile with the real intelio_harness CLI rules, then prints the
fork report. A refusal prints to stderr and leaves stdout empty.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from alans_way.report import ForkRefusal, load_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="alans_way")
    parser.add_argument("profile_dir", type=Path)
    parser.add_argument("--pin", type=Path, default=None)
    args = parser.parse_args(argv)
    try:
        report = load_report(args.profile_dir, pin_path=args.pin)
    except ForkRefusal as exc:
        print(f"intelio-harness: refused to start: {exc}", file=sys.stderr)
        return 1
    json.dump(report, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
