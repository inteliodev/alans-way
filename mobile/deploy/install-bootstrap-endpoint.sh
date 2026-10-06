#!/usr/bin/env bash
# Install the loopback Intelio key bootstrap. cloudflared on the VPS publishes it.
# This does not edit cloudflared, open a firewall port, or restart hermes-gateway.
# Do not run it from CI. Review it, then run it on the VPS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/intelio-bootstrap.service"
DRY=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY=1; fi

echo "intelio bootstrap listens on 127.0.0.1:8660"
echo "Add this cloudflared ingress rule above the os.intelio-ai.com catch-all:"
cat <<'EOF'
- hostname: os.intelio-ai.com
  path: ^/intelio/bootstrap$
  service: http://127.0.0.1:8660
EOF
echo "This installer does not edit cloudflared, does not open UFW, and does not restart hermes-gateway."

if [[ "$DRY" == 1 ]]; then
  echo "dry-run: no files written"
  exit 0
fi

NODE="$(command -v node)"
mkdir -p "$UNIT_DIR"

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Intelio Cloudflare Access key bootstrap
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$NODE $ROOT/mobile/bootstrap/server.cjs
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now intelio-bootstrap.service
systemctl --user --no-pager --quiet is-active intelio-bootstrap.service
echo "intelio-bootstrap.service is active on 127.0.0.1:8660"
