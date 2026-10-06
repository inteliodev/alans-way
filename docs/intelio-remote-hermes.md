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
- API keys: you do not type them. Place `remote-hermes-key.import` in the app data folder (`Hermes Workspace`) before launch. The file can hold several lines, `<profile>=<key>`. A legacy `API_SERVER_KEY=...` line, or a single raw key, is the intelio key. Intelio encrypts every usable line with Electron
  `safeStorage` (Windows DPAPI, macOS Keychain, or libsecret) in `remote-hermes-keys.json` (mode 600), securely deletes the import file, and shows **Connected to VPS Hermes**. Each `/p/<profile>` route accepts only that profile’s key. Keys are
  only used in the main process. They are never sent to a renderer, never logged,
  and redacted from errors. A rotated key replaces the stored one when a new import file is present at the next launch.
- A fresh Windows install starts in this mode already (that host, port 8642, profile `intelio`) even when there is no preferences file. Saved settings that omit the host keep that default. An explicit off switch stays off. With a keystore present, the main window lists those agents and does not show the Telegram sign-in note. If the VPS cannot be reached, or a profile key is rejected, the window shows that error instead of staying on “Loading…”. The first launch also asks for Tailscale if it is missing. See [Windows and the phone](intelio-windows-and-mobile.md).

The phone client reads `~/.hermes/profiles/intelio/.env` on the VPS (mode 600) and signs the browser in by Tailscale login. It does not need this import file.

Calls and texts use a separate loopback process, `mobile/phone/bridge.cjs`, on `127.0.0.1:8650`. Caddy at `https://2-24-110-12.sslip.io/twilio/*` is the public front. See [Windows and the phone](intelio-windows-and-mobile.md).

When Remote Hermes is on, the main Intelio window is the client: the agent list, sessions, history, sending, and streaming all use `/p/<profile>/api/sessions` and `/api/sessions/{id}/chat/stream`. The list comes from `/api/home` or `/api/profiles`, then from saved key names, then from the configured profile. Intelio, PRC, Alignment, and HHP keep the phone orb types (connecting, solving, searching, weaving). Sessions from photon/iMessage, Telegram, API, and one-shot stay in that list, each tagged with its source. macOS stays on local Telegram until Remote Hermes is turned on.

Window → **Remote Hermes (VPS)** (`Cmd+Shift+H`) still opens the plain session list for the configured profile.

## Code

- `desktop/src/intelio/remote-hermes.cjs` — host policy, config, SSE parser, HTTP client. Each call can name a profile and uses that profile’s key.
- `desktop/src/intelio/orb-signature.cjs` — vendored orb types, so the packaged app does not require the phone tree.
- `desktop/src/intelio/preferences.cjs` — fresh-profile remote defaults.
- `desktop/src/intelio/remote-main-data.cjs` — main-window agent list, session tags, and fallbacks. Profile discovery times out, then uses saved key names.
- `desktop/src/intelio/remote-hermes-main.cjs` — settings commands, multi-key import, encrypted key store, IPC.
- `desktop/src/remote-main.js` — profile switcher and chat in the main window.
- `desktop/src/remote-hermes.html|css`, `desktop/src/remote-hermes-ui.js` — plain chat window (CSP `connect-src 'none'`; all traffic via IPC).
- `desktop/test/remote-hermes.test.cjs`, `desktop/test/remote-main-data.test.cjs`, `desktop/test/remote-hermes-import.test.cjs`, `desktop/test/fresh-windows-remote.test.cjs`, `desktop/test/packaged-requires.test.cjs` — host policy, the main-window data layer, the switcher, multi-key import, a fresh Windows profile, and packaged require paths.

## Not yet

- Push instead of polling (Hermes has run SSE per turn, not a session-change feed).
- Tool approval prompts from API turns (`/v1/runs/{id}/approval`) are not surfaced; ask-first actions wait server-side.
