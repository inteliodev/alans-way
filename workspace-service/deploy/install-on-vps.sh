#!/usr/bin/env bash
# Install or upgrade the intelio Workspace (cloud coding) on the VPS. Run it there yourself,
# from a checkout of this repo (the live one is the intelio-pwa.service WorkingDirectory):
#
#   cd "$(systemctl --user show -p WorkingDirectory --value intelio-pwa.service)"
#   git pull
#   bash workspace-service/deploy/install-on-vps.sh
#
# The service runs from its own runtime folder (default ~/intelio-workspace). This script
# copies the code there and leaves the runtime state alone: data/ (tasks, runs), logs/,
# node_modules/, static/vendor/ and config.env are never overwritten or deleted. It also
# installs the push guard (~/workspaces/hooks, ~/workspaces/bin), the builder profile's
# helper skills and the systemd --user unit, then restarts intelio-workspace.service only.
# KillMode=process keeps the task tmux sessions alive across that restart.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="${INTELIO_WORKSPACE_DIR:-$HOME/intelio-workspace}"
WORKSPACES="${INTELIO_WORKSPACES:-$HOME/workspaces}"
BUILDER_SKILLS="${INTELIO_BUILDER_SKILLS:-$HOME/.hermes/profiles/builder/skills/autonomous-ai-agents}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT=intelio-workspace.service

DRY=0
RESTART=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --no-restart) RESTART=0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

run() { if [[ "$DRY" == 1 ]]; then echo "+ $*"; else "$@"; fi; }

echo "Workspace source:  $SRC"
echo "Workspace runtime: $RUNTIME"
run mkdir -p "$RUNTIME" "$RUNTIME/data" "$RUNTIME/logs" "$RUNTIME/static/vendor"

# Code only. No --delete: runtime state and anything the runtime added stays.
run rsync -a \
  --exclude node_modules/ --exclude data/ --exclude logs/ --exclude static/vendor/ \
  --exclude config.env --exclude .git/ --exclude .gitignore \
  "$SRC/" "$RUNTIME/"

if [[ ! -f "$RUNTIME/config.env" ]]; then
  echo "No config.env yet: copying config.env.example (edit WS_BIND / WS_ALLOWED_LOGINS if needed)."
  run cp "$SRC/config.env.example" "$RUNTIME/config.env"
fi

LOCK_SUM="$(sha256sum "$SRC/package-lock.json" | cut -d' ' -f1)"
STAMP="$RUNTIME/node_modules/.intelio-lock"
if [[ ! -d "$RUNTIME/node_modules" ]] || [[ "$(cat "$STAMP" 2>/dev/null || true)" != "$LOCK_SUM" ]]; then
  if [[ -d "$RUNTIME/node_modules/node-pty" && ! -f "$STAMP" ]]; then
    # First run against an existing install: keep the built node-pty, just record the lock.
    echo "Existing node_modules kept (recording package-lock checksum)."
    [[ "$DRY" == 1 ]] || echo "$LOCK_SUM" > "$STAMP"
  else
    echo "Installing dependencies (npm ci)…"
    (cd "$RUNTIME" && run npm ci --omit=dev --no-audit --no-fund)
    [[ "$DRY" == 1 ]] || echo "$LOCK_SUM" > "$STAMP"
  fi
fi
if [[ ! -f "$RUNTIME/static/vendor/xterm.js" ]]; then
  (cd "$RUNTIME" && run npm run vendor)
fi

# Push guard: only main asks (see README).
run mkdir -p "$WORKSPACES/hooks" "$WORKSPACES/bin" "$WORKSPACES/grants" "$WORKSPACES/repos" "$WORKSPACES/tasks"
run install -m 755 "$SRC/deploy/hooks/pre-push" "$WORKSPACES/hooks/pre-push"
for bin in "$SRC"/deploy/bin/*; do
  run install -m 755 "$bin" "$WORKSPACES/bin/$(basename "$bin")"
done

# Helper skills for the builder profile (taken up by the next Hermes session).
if [[ -d "$(dirname "$BUILDER_SKILLS")" ]]; then
  for skill in "$SRC"/builder-skills/*/; do
    name="$(basename "$skill")"
    run mkdir -p "$BUILDER_SKILLS/$name"
    run rsync -a "$skill" "$BUILDER_SKILLS/$name/"
  done
else
  echo "No builder profile at $(dirname "$BUILDER_SKILLS"); skipped the helper skills."
fi

run mkdir -p "$UNIT_DIR"
if ! cmp -s "$SRC/$UNIT" "$UNIT_DIR/$UNIT"; then
  run install -m 644 "$SRC/$UNIT" "$UNIT_DIR/$UNIT"
  run systemctl --user daemon-reload
  run systemctl --user enable "$UNIT"
fi

if [[ "$RESTART" == 1 ]]; then
  run systemctl --user restart "$UNIT"
  if [[ "$DRY" != 1 ]]; then
    sleep 2
    systemctl --user is-active --quiet "$UNIT" && echo "$UNIT is running." || { echo "$UNIT did not start; see $RUNTIME/logs/stdout.log" >&2; exit 1; }
  fi
fi
echo "Done. Hermes gateways and intelio-pwa.service were not touched."
