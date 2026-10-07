#!/bin/sh
# Harness-side Bot Desktop maximize. This is not Hermes code.
#
# Each profile display has its own authority file:
#   ~/.hermes/profiles/<profile>/bot-desktop/display      (contents 20 or :20)
#   ~/.hermes/profiles/<profile>/bot-desktop/Xauthority
#
# Hermes writes the display number without a colon. This script adds ":" before
# matching that file to an X socket.
#
# --all walks existing X sockets on :20 and up. A missing display is skipped.
# wmctrl is used only when it can see a window manager. Display :99 has none,
# so wmctrl -m failing falls through to xdotool. A failed xdotool does not
# print success.
#
#   bash scripts/bot-desktop-maximize.sh :20
#   bash scripts/bot-desktop-maximize.sh --all
#   bash scripts/bot-desktop-maximize.sh --watch
#
# The user unit scripts/intelio-bot-desktop-maximize.service runs --watch.

set -eu

quiet=0
missing_logged=""

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

display_exists() {
  num=${1#:}
  [ -S "$(x11_dir)/X${num}" ]
}

xauthority_for() {
  display=$(normalize_display "$1")
  root=$(profiles_root)
  [ -d "$root" ] || return 1
  for dir in "$root"/*/bot-desktop; do
    [ -d "$dir" ] || continue
    [ -f "$dir/display" ] || continue
    current=$(normalize_display "$(tr -d '[:space:]' < "$dir/display")")
    if [ "$current" = "$display" ] && [ -f "$dir/Xauthority" ]; then
      printf '%s\n' "$dir/Xauthority"
      return 0
    fi
  done
  return 1
}

log_missing() {
  display=$1
  case " $missing_logged " in
    *" $display "*) return 0 ;;
  esac
  missing_logged="$missing_logged $display"
  echo "No Chromium window on $display" >&2
}

clear_missing() {
  display=$1
  next=""
  for item in $missing_logged; do
    if [ "$item" != "$display" ]; then
      next="$next $item"
    fi
  done
  missing_logged=$next
}

maximize_one() {
  display=$(normalize_display "$1")
  case "$display" in
    :[0-9]*) ;;
    *) echo "Display must look like :20" >&2; return 1 ;;
  esac
  if ! display_exists "$display"; then
    echo "No X display $display" >&2
    return 1
  fi
  # A display with no authority file must not inherit the previous display.
  unset XAUTHORITY
  auth=$(xauthority_for "$display" || true)
  if [ -n "$auth" ]; then
    XAUTHORITY=$auth
    export XAUTHORITY
  fi
  DISPLAY=$display
  export DISPLAY
  # wmctrl -m fails when the display has no window manager (:99). Use xdotool there.
  if command -v wmctrl >/dev/null 2>&1 && wmctrl -m >/dev/null 2>&1; then
    ids=$(wmctrl -l -x 2>/dev/null | awk 'BEGIN{IGNORECASE=1} /chromium|chrome|google-chrome/ {print $1}')
    if [ -z "$ids" ]; then
      log_missing "$display"
      return 1
    fi
    clear_missing "$display"
    for id in $ids; do
      if ! wmctrl -i -r "$id" -b add,maximized_vert,maximized_horz; then
        echo "wmctrl failed on $display" >&2
        return 1
      fi
    done
    if [ "$quiet" -eq 0 ]; then
      echo "Maximized Chromium on $display"
    fi
    return 0
  fi
  if command -v xdotool >/dev/null 2>&1; then
    if xdotool search --class chromium windowmove 0 0 windowsize 1920 1080 \
      || xdotool search --class Chromium windowmove 0 0 windowsize 1920 1080; then
      if [ "$quiet" -eq 0 ]; then
        echo "Maximized Chromium on $display"
      fi
      return 0
    fi
    echo "xdotool failed on $display" >&2
    return 1
  fi
  echo "Install wmctrl or xdotool on the VPS, then rerun for $display" >&2
  return 1
}

existing_displays() {
  if [ -n "${INTELIO_BOT_DISPLAYS:-}" ]; then
    for display in $INTELIO_BOT_DISPLAYS; do
      display=$(normalize_display "$display")
      if display_exists "$display"; then
        printf '%s\n' "$display"
      fi
    done
    return
  fi
  dir=$(x11_dir)
  [ -d "$dir" ] || return 0
  for sock in "$dir"/X*; do
    [ -S "$sock" ] || continue
    num=${sock##*/X}
    case "$num" in
      ''|*[!0-9]*) continue ;;
    esac
    if [ "$num" -ge 20 ]; then
      printf ':%s\n' "$num"
    fi
  done
}

run_all() {
  found=0
  failed=0
  for display in $(existing_displays); do
    found=1
    if ! maximize_one "$display"; then
      failed=1
    fi
  done
  if [ "$found" -eq 0 ]; then
    echo "No Bot Desktop displays are up." >&2
    return 1
  fi
  return "$failed"
}

watch_loop() {
  quiet=1
  while true; do
    run_all || true
    sleep "${INTELIO_BOT_WATCH_SECONDS:-2}"
  done
}

if [ "${1:-}" = "--watch" ]; then
  watch_loop
elif [ "${1:-}" = "--all" ] || [ "${1:-}" = "" ]; then
  run_all
else
  maximize_one "$1"
fi
