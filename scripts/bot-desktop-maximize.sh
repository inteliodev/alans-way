#!/bin/sh
# Harness-side Bot Desktop maximize. This is not Hermes code.
#
# Legacy display :99 has no window manager. Chromium there already needs
# --window-position=0,0 --window-size=1920,1080 in browserArgs. Add those two
# flags to the browserArgs default in alans-way-agents setup.sh (that repo is
# not this checkout) so a fresh install matches.
#
# Bot Desktop displays are 1920x1080 Xvnc on :20 and up, with Xfce/xfwm.
# Run this on the VPS as the desktop user, once per display, or with --all:
#
#   bash scripts/bot-desktop-maximize.sh :20
#   bash scripts/bot-desktop-maximize.sh --all
#
# --all walks INTELIO_BOT_DISPLAYS (default ":20 :21 :22 :23").

set -eu

maximize_one() {
  display="$1"
  case "$display" in
    :*) ;;
    *) echo "Display must look like :20" >&2; return 1 ;;
  esac
  if command -v wmctrl >/dev/null 2>&1; then
    DISPLAY="$display" wmctrl -l -x 2>/dev/null | awk 'BEGIN{IGNORECASE=1} /chromium|chrome|google-chrome/ {print $1}' | while read -r id; do
      [ -n "$id" ] || continue
      DISPLAY="$display" wmctrl -i -r "$id" -b add,maximized_vert,maximized_horz || true
    done
  elif command -v xdotool >/dev/null 2>&1; then
    DISPLAY="$display" xdotool search --class chromium windowmove 0 0 windowsize 1920 1080 || true
    DISPLAY="$display" xdotool search --class Chromium windowmove 0 0 windowsize 1920 1080 || true
  else
    echo "Install wmctrl or xdotool on the VPS, then rerun for $display" >&2
    return 1
  fi
  echo "Maximized Chromium on $display"
}

if [ "${1:-}" = "--all" ] || [ "${1:-}" = "" ]; then
  displays="${INTELIO_BOT_DISPLAYS:-:20 :21 :22 :23}"
  for display in $displays; do
    maximize_one "$display" || true
  done
else
  maximize_one "$1"
fi
