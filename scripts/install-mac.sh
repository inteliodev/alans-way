#!/bin/sh
# install-mac.sh — build and install (or upgrade) the Alan's Way Mac app.
#
#   curl -fsSL https://openalan.com/install-mac | sh
#
# Clones or fast-forwards the repo into $ALANS_WAY_DIR (default ~/alans-way),
# builds the app locally (so macOS does not quarantine it), replaces
# /Applications/alans-way-localapp.app and opens it. Sign-ins and settings live
# outside the bundle and survive upgrades. Safe to re-run.
set -eu

# Canonical clone URL is intelio/forks.json. The default matches that file so a
# curled copy of this script still clones the Intelio fork.
REPO_URL="https://github.com/inteliodev/alans-way"
FORKS="$(CDPATH= cd -- "$(dirname "$0")" && pwd)/../intelio/forks.json"
if [ -f "$FORKS" ]; then
  PARSED=$(sed -n 's/^[[:space:]]*"app"[[:space:]]*:[[:space:]]*"\(https:\/\/github.com\/inteliodev\/alans-way\)".*/\1/p' "$FORKS")
  [ -n "$PARSED" ] && REPO_URL="$PARSED"
fi
DIR="${ALANS_WAY_DIR:-$HOME/alans-way}"
APP_NAME="alans-way-localapp"
DEST="/Applications/$APP_NAME.app"

say() { printf '%s\n' "$*"; }
die() { printf 'install-mac: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this installs the Mac app; run it on macOS"
[ "$(uname -m)" = arm64 ] || die "Apple Silicon only for now (uname -m printed $(uname -m))"
command -v git >/dev/null || die "git is missing — run: xcode-select --install"
command -v node >/dev/null && command -v npm >/dev/null \
  || die "Node 20+ is missing — install it (for example: brew install node) and re-run"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 20+ required (found $(node -v))"

if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" pull --ff-only -q || die "could not fast-forward $DIR (local changes?)"
else
  [ ! -e "$DIR" ] || die "$DIR exists but is not a git checkout — move it or set ALANS_WAY_DIR"
  say "Cloning into $DIR"
  git clone -q "$REPO_URL" "$DIR"
fi
say "Version $(git -C "$DIR" rev-parse --short HEAD)"

cd "$DIR/desktop"
say "Installing dependencies"
npm ci --no-audit --no-fund --loglevel=error >/dev/null
say "Building the app"
npm run package:mac --silent >/dev/null 2>&1 || npm run package:mac
BUILT="$DIR/desktop/dist/$APP_NAME-darwin-arm64/$APP_NAME.app"
[ -d "$BUILT" ] || die "build finished but $BUILT is missing"

if pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1; then
  say "Quitting the running app"
  osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
  i=0
  while pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1 && [ "$i" -lt 15 ]; do sleep 1; i=$((i + 1)); done
  pkill -f "$DEST/Contents/MacOS/" 2>/dev/null || true
  sleep 1
fi

say "Installing to $DEST"
rm -rf "$DEST.new"
ditto "$BUILT" "$DEST.new"
rm -rf "$DEST"
mv "$DEST.new" "$DEST"
open "$DEST"

CONN="$HOME/Library/Application Support/Hermes Workspace/connection.json"
i=0
while [ "$i" -lt 30 ]; do
  if [ -f "$CONN" ] && STATUS="$(node -e '
    const c = require(process.argv[1]);
    fetch(c.url + "/v1/status", { headers: { Authorization: "Bearer " + c.token } })
      .then((r) => r.json()).then((s) => { if (!s.version) process.exit(1); console.log(s.host + " " + s.version); })
      .catch(() => process.exit(1));' "$CONN" 2>/dev/null)"; then
    say "install-mac: running — local browser API answers ($STATUS)"
    exit 0
  fi
  sleep 1; i=$((i + 1))
done
die "the app was installed but its local API did not answer within 30s — open $DEST and check it starts"
