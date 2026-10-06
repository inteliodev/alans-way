# Remote Hermes (VPS) mode

"One Hermes": the Intelio VPS (`intelio-vps.tail9c1007.ts.net`)
runs the single Hermes brain — one multiplexed gateway serving Telegram
(@inteliodevbot, profile `intelio`) and the Hermes API server. The desktop app,
the phone and Telegram are clients of it. Sessions, memory, skills and the model
provider all live on the VPS. The listener address is whatever `tailscale ip -4`
prints on that machine; this doc does not repeat it.

## Why the API server (and not SSH + TUI)

Hermes at the pinned commit `5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662` ships an
API server inside the gateway (`gateway/platforms/api_server.py`, docs:
`website/docs/user-guide/features/api-server.md`). It exposes the gateway's own
`SessionDB`, so the app sees the *same* sessions Telegram writes:

| Endpoint (under `/p/<profile>`) | Used for |
|---|---|
| `GET /api/sessions?source=telegram` | session list (Telegram, app/API, CLI, cron) |
| `GET /api/sessions/{id}/messages?inline_images=false` | transcript |
| `POST /api/sessions` | new chat |
| `POST /api/sessions/{id}/chat/stream` | one agent turn, SSE (`assistant.delta`, `tool.*`, `assistant.completed`, `run.completed`, `done`) |
| `GET /v1/capabilities`, `GET /health` | connection test |

Driving `hermes -p <profile>` over SSH would start a second agent process with
its own runtime next to the gateway, and the TUI protocol is not a stable
client API. The API server is the supported multi-client surface, so this mode
uses it.

Turns sent from the app run in the chosen session on the VPS (same memory and
skills). Replies to an app turn come back to the app; they are not re-posted
into the Telegram chat. Telegram turns show up in the app on the next poll (8 s).

## VPS side (already enabled on srv1685012)

- `~/.hermes/.env` (default profile, owns the multiplexed listener):
  `API_SERVER_ENABLED=true`, `API_SERVER_HOST` set to the tailnet address from
  `tailscale ip -4`, `API_SERVER_PORT=8642`, `API_SERVER_KEY=<random>`.
- `~/.hermes/profiles/intelio/.env`: its own `API_SERVER_KEY=<random>`. Hermes
  binds keys to the routed profile: `/p/intelio/...` only accepts the intelio key.
- `ufw allow in on tailscale0 to any port 8642 proto tcp`. The listener is bound
  to the tailnet address, never a wildcard address; the Hostinger panel still only allows 22.
- systemd drop-in `hermes-gateway.service.d/10-intelio-tailnet-wait.conf` waits up
  to ~80 s for the tailnet IP at boot so the bind does not fail.

## App side

Settings → **Remote Hermes (VPS)**:

- Host: `intelio-vps.tail9c1007.ts.net` (or the tailnet address from `tailscale ip -4`). Only Tailscale
  addresses (the CGNAT range Tailscale assigns, `fd7a:115c:a1e0::/48`, `*.ts.net`) or loopback
  (for an SSH tunnel to the VPS) are accepted; anything
  else is refused before a request is made.
- Port: `8642`. Profile: `intelio` (`default` = unprefixed routes).
- API key: you do not type it. Place `remote-hermes-key.import` in the app data folder (`Hermes Workspace`) before launch. Intelio encrypts it with Electron
  `safeStorage` (Windows DPAPI, macOS Keychain, or libsecret) in `remote-hermes-keys.json` (mode 600), securely deletes the import file, and shows **Connected to VPS Hermes**. The key is
  only used in the main process. It is never sent to a renderer, never logged,
  and redacted from errors. A rotated key replaces the stored one when a new import file is present at the next launch.
- A fresh Windows install starts in this mode already (that host, port 8642, profile `intelio`) and asks for Tailscale if it is missing. See [Windows and the phone](intelio-windows-and-mobile.md).

The phone client reads `~/.hermes/profiles/intelio/.env` on the VPS (mode 600) and signs the browser in by Tailscale login. It does not need this import file.

Open the chat with Window → **Remote Hermes (VPS)** (`Cmd+Shift+H`) or the
Settings button. The left list shows sessions from every surface (filter by
Telegram / App / CLI / Cron); pick one to read and continue it, or **New**.

## Code

- `desktop/src/intelio/remote-hermes.cjs` — host policy, config, SSE parser, HTTP client.
- `desktop/src/intelio/remote-hermes-main.cjs` — settings commands, encrypted key store, IPC, window.
- `desktop/src/remote-hermes.html|css`, `desktop/src/remote-hermes-ui.js` — chat window (CSP `connect-src 'none'`; all traffic via IPC).
- `desktop/test/remote-hermes.test.cjs` — host policy, redaction, SSE, client against a stub server.

## Not yet

- Multiple profiles at once (one active profile + key at a time; keys are stored per profile).
- Push instead of polling (Hermes has run SSE per turn, not a session-change feed).
- Tool approval prompts from API turns (`/v1/runs/{id}/approval`) are not surfaced; ask-first actions wait server-side.
