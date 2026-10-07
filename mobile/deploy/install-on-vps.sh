#!/usr/bin/env bash
# Install or upgrade the Intelio phone client on the VPS. Run it there yourself.
# Nothing in this repository deploys remotely. The listener must be a Tailscale
# address (or loopback for a local check). Voice, when requested, runs inside
# this same process: no extra port, and no public firewall rule.
#
# Upgrade in place (keeps the existing bind, cert, and key paths):
#   git pull
#   bash mobile/deploy/install-on-vps.sh --with-voice
# Voice packages install before the service restarts. A failed voice install
# leaves the running phone client alone.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

DRY=0
WITH_VOICE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --with-voice) WITH_VOICE=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

WHISPER_PIN="faster-whisper==1.2.1"
PIPER_PIN="piper-tts==1.3.0"
# PyAV 19 dropped av.open(metadata_errors=...), which faster-whisper 1.2.1 still passes.
AV_PIN="av==18.1.0"
WHISPER_MODEL="base"
WHISPER_COMPUTE="int8"
PIPER_NAME="en_US-lessac-medium"
PIPER_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium"

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/intelio"
UNIT="$UNIT_DIR/intelio-pwa.service"
ENV_FILE="$ENV_DIR/pwa.env"
VENV="${XDG_DATA_HOME:-$HOME/.local/share}/intelio-voice"
VOICE_DIR="$ENV_DIR/voices"
HF_HOME="${XDG_CACHE_HOME:-$HOME/.cache}/intelio-voice"

env_get() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    printf ''
    return 0
  fi
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
  printf '%s' "${line#*=}"
}

FILE_BIND="$(env_get INTELIO_PWA_BIND)"
FILE_PORT="$(env_get INTELIO_PWA_PORT)"
FILE_HERMES="$(env_get INTELIO_HERMES_URL)"
FILE_PROFILE="$(env_get INTELIO_HERMES_PROFILE)"
BIND="${INTELIO_PWA_BIND:-$FILE_BIND}"
PORT="${INTELIO_PWA_PORT:-${FILE_PORT:-8643}}"
PROFILE="${INTELIO_HERMES_PROFILE:-${FILE_PROFILE:-intelio}}"
FILE_LOGINS="$(env_get INTELIO_PWA_ALLOWED_LOGINS)"
LOGINS="${INTELIO_PWA_ALLOWED_LOGINS:-$FILE_LOGINS}"

hermes_is_loopback() {
  node -e 'try { const host = new URL(process.argv[1]).hostname.replace(/^\[|\]$/g, ""); process.exit(host === "127.0.0.1" || host === "localhost" || host === "::1" ? 0 : 1); } catch { process.exit(1); }' "$1"
}

if [[ -n "${INTELIO_HERMES_URL:-}" ]]; then
  HERMES_URL="$INTELIO_HERMES_URL"
elif [[ -n "$FILE_HERMES" ]] && ! hermes_is_loopback "$FILE_HERMES"; then
  HERMES_URL="$FILE_HERMES"
else
  HERMES_URL=""
fi
# Hermes on this VPS is bound to the tailnet address from `tailscale ip -4`, not loopback.
if [[ -z "$HERMES_URL" ]] || hermes_is_loopback "$HERMES_URL"; then
  TS_IP=""
  if command -v tailscale >/dev/null 2>&1; then
    TS_IP="$(tailscale ip -4 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)"
  fi
  if [[ -n "$TS_IP" ]]; then
    node -e 'const {isTailnetOrLoopbackHost}=require(process.argv[1]); if(!isTailnetOrLoopbackHost(process.argv[2])) process.exit(1);' "$ROOT/desktop/src/intelio/remote-hermes.cjs" "$TS_IP"
    HERMES_URL="http://${TS_IP}:8642"
  elif [[ "$DRY" == 1 ]]; then
    HERMES_URL="http://intelio-vps.tail9c1007.ts.net:8642"
    echo "No local tailscale ip; dry-run uses the MagicDNS name. On the VPS the script uses tailscale ip -4."
  else
    echo "Hermes listens on the tailnet address, not loopback. Set INTELIO_HERMES_URL or install Tailscale. The phone service was not restarted." >&2
    exit 1
  fi
fi
CERT="${INTELIO_PWA_CERT:-$(env_get INTELIO_PWA_CERT)}"
KEYF="${INTELIO_PWA_KEY:-$(env_get INTELIO_PWA_KEY)}"
VOICE_PY="${INTELIO_VOICE_PYTHON:-$(env_get INTELIO_VOICE_PYTHON)}"
PIPER_MODEL="${INTELIO_VOICE_PIPER_MODEL:-$(env_get INTELIO_VOICE_PIPER_MODEL)}"
VOICE_THREADS="${INTELIO_VOICE_THREADS:-$(env_get INTELIO_VOICE_THREADS)}"
VOICE_THREADS="${VOICE_THREADS:-2}"

ACCESS="${INTELIO_PWA_ACCESS:-$(env_get INTELIO_PWA_ACCESS)}"
if [[ "$ACCESS" == "1" && -z "$BIND" ]]; then
  BIND="127.0.0.1"
fi
if [[ -z "$BIND" ]]; then
  echo "Set INTELIO_PWA_BIND to the Tailscale name or tailnet address." >&2
  exit 1
fi
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [[ "$PORT" -lt 1 || "$PORT" -gt 65535 ]]; then
  echo "INTELIO_PWA_PORT must be 1-65535." >&2
  exit 1
fi

node -e 'const {isTailnetOrLoopbackHost}=require(process.argv[1]); if(!isTailnetOrLoopbackHost(process.argv[2])) { console.error("Refusing bind. Use a Tailscale address or loopback, never a public or wildcard address."); process.exit(1); }' "$ROOT/desktop/src/intelio/remote-hermes.cjs" "$BIND"

echo "Phone client root: $ROOT"
echo "Bind: $BIND port $PORT"
echo "Hermes upstream: $HERMES_URL profile $PROFILE"
if [[ "$ACCESS" == "1" ]]; then
  echo "Access hostname app.intelio-ai.com → http://127.0.0.1:${PORT}/"
  echo "Tunnel ingress service: http://127.0.0.1:${PORT}"
  echo "No path prefix. start_url and scope are /. Do not open UFW 8643."
else
  echo "ufw: allow in on tailscale0 to port $PORT proto tcp"
fi
if [[ "$ACCESS" != "1" && -z "$LOGINS" ]]; then
  if [[ "$DRY" == 1 ]]; then
    echo "Allowlist: read from tailscale status --json (Self user LoginName). Not hardcoded."
  else
    LOGINS=$(tailscale status --json | node "$ROOT/mobile/pwa/identity.cjs" --login-from-status) || {
      echo "Could not read the Tailscale login. Set INTELIO_PWA_ALLOWED_LOGINS. The phone service was not restarted." >&2
      exit 1
    }
  fi
fi
if [[ -n "$LOGINS" ]]; then echo "Allowlist: $LOGINS"; fi
if [[ -n "$CERT" ]]; then echo "Keeping TLS cert path from the environment or the existing env file."; fi
if [[ "$WITH_VOICE" == 1 ]]; then
  echo "Voice pins: $WHISPER_PIN $PIPER_PIN $AV_PIN"
  echo "Voice models: whisper $WHISPER_MODEL $WHISPER_COMPUTE, piper $PIPER_NAME"
  echo "Voice venv: $VENV"
  echo "Voice stays in-process. No extra port is opened."
fi

if [[ "$DRY" == 1 ]]; then
  echo "Dry run only. No files written and no firewall change."
  exit 0
fi

install_voice() {
  if ! python3 -m venv "$VENV"; then
    echo "python3 venv failed. Install python3-venv, then rerun. The phone service was not restarted." >&2
    exit 1
  fi
  "$VENV/bin/pip" install --disable-pip-version-check "$WHISPER_PIN" "$PIPER_PIN" "$AV_PIN"
  mkdir -p "$VOICE_DIR" "$HF_HOME"
  local onnx="$VOICE_DIR/$PIPER_NAME.onnx"
  local config="$VOICE_DIR/$PIPER_NAME.onnx.json"
  if [[ ! -s "$onnx" ]]; then
    curl -fsSL "$PIPER_BASE/$PIPER_NAME.onnx" -o "$onnx.partial"
    mv "$onnx.partial" "$onnx"
  fi
  if [[ ! -s "$config" ]]; then
    curl -fsSL "$PIPER_BASE/$PIPER_NAME.onnx.json" -o "$config.partial"
    mv "$config.partial" "$config"
  fi
  HF_HOME="$HF_HOME" INTELIO_VOICE_PIPER_MODEL="$onnx" INTELIO_VOICE_WHISPER_MODEL="$WHISPER_MODEL" INTELIO_VOICE_WHISPER_COMPUTE="$WHISPER_COMPUTE" INTELIO_VOICE_THREADS="$VOICE_THREADS" \
    "$VENV/bin/python" -c 'from faster_whisper import WhisperModel; import os; WhisperModel(os.environ["INTELIO_VOICE_WHISPER_MODEL"], device="cpu", compute_type=os.environ["INTELIO_VOICE_WHISPER_COMPUTE"], cpu_threads=int(os.environ["INTELIO_VOICE_THREADS"])); from piper.voice import PiperVoice; PiperVoice.load(os.environ["INTELIO_VOICE_PIPER_MODEL"]); print("voice-ready")'
  VOICE_PY="$VENV/bin/python"
  PIPER_MODEL="$onnx"
}

if [[ "$WITH_VOICE" == 1 ]]; then
  install_voice
fi

mkdir -p "$UNIT_DIR" "$ENV_DIR"
umask 077
{
  printf 'INTELIO_PWA_BIND=%s\n' "$BIND"
  printf 'INTELIO_PWA_PORT=%s\n' "$PORT"
  if [[ "$ACCESS" == "1" ]]; then printf 'INTELIO_PWA_ACCESS=1\n'; fi
  printf 'INTELIO_HERMES_URL=%s\n' "$HERMES_URL"
  printf 'INTELIO_HERMES_PROFILE=%s\n' "$PROFILE"
  if [[ -n "$LOGINS" ]]; then printf 'INTELIO_PWA_ALLOWED_LOGINS=%s\n' "$LOGINS"; fi
  if [[ -n "$CERT" ]]; then printf 'INTELIO_PWA_CERT=%s\n' "$CERT"; fi
  if [[ -n "$KEYF" ]]; then printf 'INTELIO_PWA_KEY=%s\n' "$KEYF"; fi
  if [[ -n "$VOICE_PY" ]]; then
    printf 'INTELIO_VOICE_PYTHON=%s\n' "$VOICE_PY"
    printf 'INTELIO_VOICE_WHISPER_MODEL=%s\n' "$WHISPER_MODEL"
    printf 'INTELIO_VOICE_WHISPER_COMPUTE=%s\n' "$WHISPER_COMPUTE"
    printf 'INTELIO_VOICE_THREADS=%s\n' "$VOICE_THREADS"
    printf 'HF_HOME=%s\n' "$HF_HOME"
  fi
  if [[ -n "$PIPER_MODEL" ]]; then printf 'INTELIO_VOICE_PIPER_MODEL=%s\n' "$PIPER_MODEL"; fi
} > "$ENV_FILE"
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
if systemctl --user is-enabled intelio-pwa.service >/dev/null 2>&1; then
  systemctl --user restart intelio-pwa.service
else
  systemctl --user enable --now intelio-pwa.service
fi

if [[ "$ACCESS" == "1" ]]; then
  echo "Cloudflare tunnel reaches 127.0.0.1:${PORT}. No UFW rule was added."
elif sudo ufw status | grep -F "Intelio phone client" | grep -q "$PORT"; then
  echo "ufw tailnet rule already present for port $PORT"
else
  sudo ufw allow in on tailscale0 to any port "$PORT" proto tcp comment 'Intelio phone client, tailnet only'
fi
echo "If this user service should survive logout: sudo loginctl enable-linger \"$USER\""
echo "Do not add a public firewall rule for this port."
echo "This installer does not restart hermes-gateway. The phone asks before: systemctl --user restart hermes-gateway"
