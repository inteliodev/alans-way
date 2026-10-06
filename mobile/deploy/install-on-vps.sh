#!/usr/bin/env bash
# Install the Intelio phone client on the VPS. Run this yourself; nothing here
# deploys remotely. The listener must be a Tailscale address (or loopback for a
# local check). The firewall rule is limited to the tailscale0 interface.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
DRY=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY=1; fi

BIND="${INTELIO_PWA_BIND:?Set INTELIO_PWA_BIND to the Tailscale name or tailnet address}"
PORT="${INTELIO_PWA_PORT:-8643}"
HERMES_URL="${INTELIO_HERMES_URL:-http://127.0.0.1:8642}"
PROFILE="${INTELIO_HERMES_PROFILE:-intelio}"

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [[ "$PORT" -lt 1 || "$PORT" -gt 65535 ]]; then
  echo "INTELIO_PWA_PORT must be 1-65535." >&2
  exit 1
fi

node -e 'const {isTailnetOrLoopbackHost}=require(process.argv[1]); if(!isTailnetOrLoopbackHost(process.argv[2])) { console.error("Refusing bind. Use a Tailscale address or loopback, never a public or wildcard address."); process.exit(1); }' "$ROOT/desktop/src/intelio/remote-hermes.cjs" "$BIND"

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/intelio"
UNIT="$UNIT_DIR/intelio-pwa.service"
ENV_FILE="$ENV_DIR/pwa.env"

echo "Phone client root: $ROOT"
echo "Bind: $BIND port $PORT"
echo "Hermes upstream: $HERMES_URL profile $PROFILE"
echo "ufw: allow in on tailscale0 to port $PORT proto tcp"

if [[ "$DRY" == 1 ]]; then
  echo "Dry run only. No files written and no firewall change."
  exit 0
fi

mkdir -p "$UNIT_DIR" "$ENV_DIR"
umask 077
cat > "$ENV_FILE" <<EOF
INTELIO_PWA_BIND=$BIND
INTELIO_PWA_PORT=$PORT
INTELIO_HERMES_URL=$HERMES_URL
INTELIO_HERMES_PROFILE=$PROFILE
EOF
# Optional TLS from \`tailscale cert\`. Leave unset for plain HTTP on the tailnet.
if [[ -n "${INTELIO_PWA_CERT:-}" ]]; then echo "INTELIO_PWA_CERT=$INTELIO_PWA_CERT" >> "$ENV_FILE"; fi
if [[ -n "${INTELIO_PWA_KEY:-}" ]]; then echo "INTELIO_PWA_KEY=$INTELIO_PWA_KEY" >> "$ENV_FILE"; fi
chmod 600 "$ENV_FILE"

cat > "$UNIT" <<EOF
[Unit]
Description=Intelio phone client (tailnet only)
After=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
WorkingDirectory=$ROOT
ExecStart=$(command -v node) $ROOT/mobile/pwa/server.cjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now intelio-pwa.service
sudo ufw allow in on tailscale0 to any port "$PORT" proto tcp comment 'Intelio phone client, tailnet only'
echo "If this user service should survive logout: sudo loginctl enable-linger \"$USER\""
echo "Do not add a public firewall rule for this port."
