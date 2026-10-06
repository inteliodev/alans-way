"""python -m intelio_harness <profile_dir>

Refuses to start when profile.yaml or the Hermes pin is missing. Prints a
JSON report on success. Does not launch Hermes and does not read .env.
"""

from __future__ import annotations

import argparse
import json
import sys

from .loader import Refusal, load_profile, public_report, redact_error


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="intelio_harness", description=__doc__)
    parser.add_argument("profile_dir", help="directory containing profile.yaml")
    parser.add_argument("--vendor", help="harness contract directory (schema, brand, pin)")
    parser.add_argument("--json", action="store_true", help="print the JSON report (always on success)")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    try:
        report = public_report(load_profile(args.profile_dir, vendor_dir=args.vendor))
    except Refusal as exc:
        print(f"intelio-harness: {redact_error(str(exc))}", file=sys.stderr)
        return exc.code
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
