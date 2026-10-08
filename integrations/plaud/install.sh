#!/usr/bin/env bash
# Install or upgrade the Plaud -> intelio transcript pipeline on the VPS. Run it there yourself,
# from the live checkout:
#
#   cd "$(systemctl --user show -p WorkingDirectory --value intelio-pwa.service)"
#   git pull
#   bash integrations/plaud/install.sh            # --dry-run prints what it would do
#
# Copies plaud-ingest and intelio-transcripts-digest into ~/.local/bin, installs the
# plaud-transcripts skill into each client profile that exists, and makes sure the user crontab
# runs plaud-ingest every 30 minutes under flock. It does not sign in to Plaud (the `plaud` CLI
# keeps its own login), does not touch transcripts already written, and does not restart Hermes.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
BIN="${INTELIO_BIN:-$HOME/.local/bin}"
PROFILES="${INTELIO_PROFILES_ROOT:-$HOME/.hermes/profiles}"
SKILL_PROFILES="${PLAUD_SKILL_PROFILES:-intelio prc alignment hhp arlp}"
CRON_LINE='*/30 * * * * flock -n /tmp/plaud-ingest.lock $HOME/.local/bin/plaud-ingest >> $HOME/.plaud-ingest/cron.log 2>&1'

DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done
run() { if [[ "$DRY" == 1 ]]; then echo "+ $*"; else "$@"; fi; }

run mkdir -p "$BIN" "$HOME/.plaud-ingest"
run install -m 755 "$SRC/plaud-ingest" "$BIN/plaud-ingest"
run install -m 755 "$SRC/intelio-transcripts-digest" "$BIN/intelio-transcripts-digest"

for profile in $SKILL_PROFILES; do
  if [[ -d "$PROFILES/$profile" ]]; then
    run mkdir -p "$PROFILES/$profile/skills/productivity/plaud-transcripts"
    run install -m 644 "$SRC/skill/plaud-transcripts/SKILL.md" "$PROFILES/$profile/skills/productivity/plaud-transcripts/SKILL.md"
  else
    echo "No profile $profile; skill not installed there."
  fi
done

CURRENT="$(crontab -l 2>/dev/null || true)"
if grep -Fq "$BIN/plaud-ingest" <<<"$CURRENT" || grep -Fq '$HOME/.local/bin/plaud-ingest' <<<"$CURRENT"; then
  echo "Cron entry already present."
else
  echo "Adding the cron entry: $CRON_LINE"
  if [[ "$DRY" != 1 ]]; then
    { [[ -n "$CURRENT" ]] && printf '%s\n' "$CURRENT"; printf '%s\n' "$CRON_LINE"; } | crontab -
  fi
fi
if ! command -v plaud >/dev/null 2>&1 && [[ ! -x "$BIN/plaud" ]]; then
  echo "Note: the plaud CLI is not installed at $BIN/plaud. Install it and sign in once; plaud-ingest uses it read-only."
fi
echo "Done."
