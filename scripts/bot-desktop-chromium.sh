#!/bin/sh
# Optional per-profile Bot Desktop Chromium. This is not Hermes code.
#
# Not started by any install step. Copy the unit, then enable it only when
# these browsers should run:
#   scripts/intelio-bot-desktop-chromium.service
#
# One process per profile, on that profile's X display, with its own
# user-data-dir and a loopback debugging port:
#   prc        9224
#   alignment  9225
#   hhp        9226
#
# Intelio stays on the shared agent browser at 127.0.0.1:9223. Debugging is
# bound to 127.0.0.1, the same rule as that browser. This script does not
# start the VPS broker and does not change its navigation policy
# (desktop/src/intelio/safety.cjs): payment hosts and /checkout, /payment,
# and /billing stay ask-first on the broker. No sandbox-disabling flags.
#
# Each profile needs:
#   ~/.hermes/profiles/<p>/bot-desktop/display      (20 or :20)
#   ~/.hermes/profiles/<p>/bot-desktop/Xauthority
# The script writes bot-desktop/cdp.url mode 600.

set -eu

profiles_root() {
  if [ -n "${HERMES_PROFILES:-}" ]; then
    printf '%s\n' "$HERMES_PROFILES"
    return
  fi
  printf '%s\n' "${HERMES_HOME:-$HOME/.hermes}/profiles"
}

x11_dir() {
  printf '%s\n' "${INTELIO_X11_DIR:-/tmp/.X11-unix}"
}

normalize_display() {
  raw=$(printf '%s' "$1" | tr -d '[:space:]')
  case "$raw" in
    :*) num=${raw#:} ;;
    *) num=$raw ;;
  esac
  case "$num" in
    ''|*[!0-9]*) printf '%s\n' "$raw"; return ;;
  esac
  printf ':%s\n' "$num"
}

chromium_bin() {
  if [ -n "${INTELIO_CHROMIUM:-}" ]; then
    printf '%s\n' "$INTELIO_CHROMIUM"
    return
  fi
  for name in chromium chromium-browser google-chrome; do
    if command -v "$name" >/dev/null 2>&1; then
      command -v "$name"
      return
    fi
  done
  return 1
}

start_one() {
  name=$1
  port=$2
  root=$(profiles_root)
  desktop="$root/$name/bot-desktop"
  [ -f "$desktop/display" ] || { echo "No display file for $name" >&2; return 1; }
  [ -f "$desktop/Xauthority" ] || { echo "No Xauthority for $name" >&2; return 1; }
  display=$(normalize_display "$(tr -d '[:space:]' < "$desktop/display")")
  case "$display" in
    :[0-9]*) ;;
    *) echo "Display for $name must look like :20" >&2; return 1 ;;
  esac
  num=${display#:}
  if [ ! -S "$(x11_dir)/X${num}" ]; then
    echo "No X display $display for $name" >&2
    return 1
  fi
  data="$desktop/chromium"
  mkdir -p "$data"
  chmod 700 "$data"
  umask 077
  printf '%s\n' "http://127.0.0.1:${port}" > "$desktop/cdp.url"
  chmod 600 "$desktop/cdp.url"
  # DISPLAY and XAUTHORITY apply only to this process. stdout is not the service pipe.
  DISPLAY=$display XAUTHORITY="$desktop/Xauthority" \
    "$bin" \
    --user-data-dir="$data" \
    --remote-debugging-port="$port" \
    --remote-debugging-address=127.0.0.1 \
    --no-first-run \
    --start-maximized \
    --window-position=0,0 \
    --window-size=1920,1080 \
    about:blank >/dev/null 2>&1 &
  pids="$pids $!"
}

bin=$(chromium_bin) || {
  echo "Chromium is not installed. Set INTELIO_CHROMIUM." >&2
  exit 1
}

pids=""
failed=0
for spec in prc:9224 alignment:9225 hhp:9226; do
  name=${spec%%:*}
  port=${spec##*:}
  start_one "$name" "$port" || failed=1
done

if [ -z "$pids" ]; then
  exit 1
fi

trap 'kill $pids 2>/dev/null || true' TERM INT
for pid in $pids; do
  wait "$pid" || failed=1
done
exit "$failed"
