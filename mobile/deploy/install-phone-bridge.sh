#!/usr/bin/env bash
# Install the loopback Twilio bridge. Caddy on the VPS is the public front.
# This does not edit Caddy, open a firewall port, or restart hermes-gateway.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${INTELIO_PHONE_ENV:-${XDG_CONFIG_HOME:-$HOME/.config}/intelio-phone/env}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/intelio-phone-bridge.service"
DEFAULT_BASE="https://2-24-110-12.sslip.io/twilio"
DRY=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY=1; fi

env_get() {
  local key="$1" file="$2"
  [[ -f "$file" ]] || return 0
  awk -v k="$key" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      line = $0
      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      eq = index(line, "=")
      if (eq == 0) next
      name = substr(line, 1, eq - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name == k) value = substr(line, eq + 1)
    }
    END { print value }
  ' "$file"
}

BASE="$(env_get PHONE_PUBLIC_BASE "$ENV_FILE")"
BASE="${BASE:-$DEFAULT_BASE}"
BASE="${BASE%/}"

echo "phone bridge listens on 127.0.0.1:8650"
echo "Caddy proxies ${BASE}/* to 127.0.0.1:8650/twilio/* with the path preserved, WebSocket upgrades, and a 64KB body limit."
echo "Twilio voice webhook: ${BASE}/voice"
echo "Twilio SMS webhook: ${BASE}/sms"
echo "ConversationRelay url: ${BASE/https:/wss:}/relay"
echo "Set SMS_WEBHOOK_URL=${BASE}/sms on each profile that should receive texts."
echo "This installer does not edit Caddy, does not open UFW, and does not restart hermes-gateway."

if [[ "$DRY" == 1 ]]; then
  echo "dry-run: no files written"
  exit 0
fi

NODE="$(command -v node)"
mkdir -p "$(dirname "$ENV_FILE")" "$UNIT_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  PWA_ENV="${XDG_CONFIG_HOME:-$HOME/.config}/intelio/pwa.env"
  HERMES="$(env_get INTELIO_HERMES_URL "$PWA_ENV")"
  if [[ -z "$HERMES" ]] && command -v tailscale >/dev/null 2>&1; then
    TS_IP="$(tailscale ip -4 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)"
    if [[ -n "$TS_IP" ]] && node -e 'const {isTailnetOrLoopbackHost}=require(process.argv[1]); process.exit(isTailnetOrLoopbackHost(process.argv[2]) ? 0 : 1)' \
      "$ROOT/desktop/src/intelio/remote-hermes.cjs" "$TS_IP"; then
      HERMES="http://${TS_IP}:8642"
    fi
  fi
  cat > "$ENV_FILE" <<EOF
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
PHONE_PUBLIC_BASE=${DEFAULT_BASE}
PHONE_ALLOWED_CALLERS=+19188991650
PHONE_NUMBER_PROFILES=
PHONE_BRIDGE_PORT=8650
INTELIO_HERMES_URL=${HERMES}
EOF
  echo "Wrote $ENV_FILE (mode 600). Fill the Twilio values and PHONE_NUMBER_PROFILES."
else
  echo "Left existing $ENV_FILE in place."
fi
chmod 600 "$ENV_FILE"

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Intelio Twilio phone bridge
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
EnvironmentFile=$ENV_FILE
ExecStart=$NODE $ROOT/mobile/phone/bridge.cjs
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload

missing=0
for key in TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN PHONE_PUBLIC_BASE PHONE_NUMBER_PROFILES INTELIO_HERMES_URL; do
  if [[ -z "$(env_get "$key" "$ENV_FILE")" ]]; then
    echo "Set $key in $ENV_FILE before the bridge can start." >&2
    missing=1
  fi
done
if [[ "$missing" == 1 ]]; then
  echo "Unit installed. Not started." >&2
  exit 1
fi

systemctl --user enable --now intelio-phone-bridge.service
systemctl --user --no-pager --quiet is-active intelio-phone-bridge.service
echo "intelio-phone-bridge.service is active on 127.0.0.1:8650"
