# intelio node — interface contract (v1)

Goal: from the phone or any computer, the intelio agent on the VPS can use every enrolled
computer (files, search, commands, screenshots) as that computer's signed-in user, plus the
VPS itself as the built-in computer "cloud", so one set of tools covers local, cloud or both.
Hermes reaches the computers ONLY through standard Hermes configuration (an MCP server entry)
and the existing alans-way plugin; no Hermes source is changed, so Hermes updates do not break it.

## Pieces

1. Node (desktop app, inteliodev/alans-way `desktop/src/intelio/node/`): runs inside the
   intelio Electron app on Windows and macOS. Dials OUT to the VPS relay over a WebSocket and
   executes tool calls locally as the signed-in OS user. No listening ports on the computer.
2. Relay (VPS, inteliodev/alans-way `mobile/pwa/`, inside the existing intelio-pwa service):
   - accepts node WebSockets at path `/node/connect` on the existing listeners
     (Access listener 127.0.0.1:8644 behind app.intelio-ai.com, and the tailnet listener 8643);
   - serves ONE aggregated MCP server for Hermes at `http://127.0.0.1:8645/mcp`
     (env `INTELIO_NODES_MCP_PORT`, default 8645, loopback bind only; never the wildcard address).
3. Hermes wiring (inteliodev/alans-way-agents setup): adds to the chosen profile(s) config:

   ```yaml
   mcp_servers:
     intelio_computers:
       url: http://127.0.0.1:8645/mcp
       headers:
         Authorization: "Bearer ${INTELIO_NODES_MCP_TOKEN}"
       timeout: 300
       connect_timeout: 30
   ```
   `INTELIO_NODES_MCP_TOKEN` lives in that profile's `.env` (mode 600). The token is created
   by `mobile/deploy/install-on-vps.sh` at `~/.config/intelio/nodes-mcp.token` (mode 600, 32+
   random bytes, hex). Default profile list: `intelio` only (PRC/Alignment/HHP are client agents
   and do NOT get the user's computers unless explicitly added).

## MCP transport (relay side)

Streamable HTTP, JSON responses (no SSE required): `POST /mcp` with JSON-RPC 2.0;
methods `initialize`, `notifications/initialized` (202, no body), `tools/list`, `tools/call`,
`ping`. Missing/wrong bearer -> HTTP 401. Protocol version: echo the client's requested
version if supported, else the latest the relay supports. Must work with the official Python
`mcp` client (`mcp.client.streamable_http.streamablehttp_client`), which is what Hermes uses.

## Tools (names are final; Hermes exposes them as mcp__intelio_computers__<name>, e.g. mcp__intelio_computers__list_computers)

Every tool except `list_computers` takes `computer` (device name or id, case-insensitive).
Offline computer -> tool result `isError: true` with text "<name> is offline (last seen …)".

| tool | args | result |
|---|---|---|
| list_computers | – | name, id, os, user, online, last_seen, version, kind (`cloud` for the VPS), paused |
| computer_info | computer | os, arch, hostname, user, home, drives/volumes, shell |
| list_dir | computer, path, show_hidden? | entries: name, type, size, mtime (max 2000, truncated flag) |
| read_file | computer, path, offset?, limit?, encoding? (text\|base64) | content (text max 1 MB / base64 max 10 MB), total_size, truncated |
| write_file | computer, path, content, encoding? (text\|base64), mode? (create\|overwrite\|append, default overwrite), make_dirs? | bytes_written, path |
| search_files | computer, root, pattern (regex for content) ?, name_glob?, max_results? (default 200), timeout_s? (default 60, max 300) | matches: path, line, text; timed_out / aborted / skipped_cloud_only when they apply |
| run_command | computer, command, cwd?, timeout_s? (default 120, max 1800), shell? | exit_code, stdout, stderr (each max 200 KB, truncated flags), duration_ms |
| screenshot | computer, display? | MCP image content (PNG) + text with display size |

Paths: absolute, or `~`-relative to the user's home. Shell: Windows = PowerShell
(`powershell.exe -NoProfile -NonInteractive -Command`), macOS/Linux = `$SHELL -lc` (fallback /bin/zsh, /bin/bash).

## Authority (access is broad; authority is not)

- Node runs with the OS account's rights only. It never elevates.
- Commands that request elevation (`sudo`, `runas`, `Start-Process … -Verb RunAs`,
  `osascript … with administrator privileges`) are refused with a clear message unless the
  user approves a native confirm dialog on that computer.
- Kill switches: on the computer, Settings → "Let my agents use this computer" or Stop on
  the "agent is using this computer" notice (OFF disconnects immediately and aborts in-flight
  calls); for any computer (including "cloud"), Settings → Your computers (the relay refuses
  calls to a paused computer; the state survives restarts).
- Audit: node appends every call (time, tool, args summary without file contents, result size,
  exit code) to `<userData>/intelio-node/audit.jsonl` (Settings → View activity); the relay
  appends the same summary (program name only, never command text) for every computer to
  `~/.config/intelio/nodes-audit.jsonl` (Settings → All agent activity).
- Managed work computers (ARLP PC on the Alliance network) are held off; see "Managed
  computers" below.

## Device identity and revocation

- First connect: node presents the user's Cloudflare Access cookie (Access listener) or comes from
  an allowed tailnet login (tailnet listener) — the same human checks server.cjs already does.
  Relay then issues `{device_id, device_secret}`; node stores the secret with Electron
  `safeStorage` (never plaintext on disk). Relay stores only a hash in
  `~/.config/intelio/nodes.json` (mode 600) with name, os, user, enrolled_at, last_seen.
- Later connects need BOTH a valid human check and the device secret.
- Revoke: `node mobile/pwa/nodes-cli.cjs revoke <name|id>` (and `list`). A revoked device is
  disconnected and refused.
- Device name defaults to the OS hostname; renameable in Settings.

## Wire protocol (node <-> relay, WebSocket text frames, JSON)

- node -> relay first frame: `{"type":"hello","device_id"?, "device_secret"?, "name","os","arch","user","version"}`
- relay -> node: `{"type":"welcome","device_id","device_secret"?}` (secret only on first enrollment) or `{"type":"refused","reason"}`
- relay -> node: `{"type":"call","id","tool","args"}`; node -> relay: `{"type":"result","id","ok":true,"content":[...MCP content...]}` or `{"type":"result","id","ok":false,"error":"..."}`
- ping/pong every 25 s; relay marks a node offline after 60 s silence; node reconnects with backoff 2 s → 60 s.

---

# Implementation notes (stage 1)

Everything above is the v1 contract and is implemented as written. The notes below
describe how this repository implements it and what is left for stage 2.

## Files

| piece | file |
|---|---|
| WebSocket (RFC 6455, stdlib) shared by node and relay | `desktop/src/intelio/node/ws.cjs` |
| Tool catalogue, limits, frames, audit summary (shared) | `desktop/src/intelio/node/protocol.cjs` |
| Node executors (files, search, commands, screenshot) | `desktop/src/intelio/node/executors.cjs` |
| Elevation detection | `desktop/src/intelio/node/elevation.cjs` |
| Node client (dial out, enroll, backoff, ping, audit, kill switch) | `desktop/src/intelio/node/client.cjs` |
| Electron glue (safeStorage, Settings, target URL, confirm dialog, first run, managed hold) | `desktop/src/intelio/node/electron.cjs` (started from `desktop/src/main.cjs`) |
| Search worker (bounded time, kill switch, cloud-only placeholders) | `desktop/src/intelio/node/search.cjs` |
| "Agent is using this computer" notice | `desktop/src/intelio/node/indicator.cjs`, `indicator.html`, `indicator-preload.cjs` |
| The "cloud" computer | `mobile/pwa/nodes-local.cjs` |
| Person-only computers API | `mobile/pwa/nodes-human.cjs` |
| Relay registry + live hub | `mobile/pwa/nodes.cjs` |
| Relay MCP server for Hermes | `mobile/pwa/nodes-mcp.cjs` |
| Operator CLI | `mobile/pwa/nodes-cli.cjs` |

The relay requires the two shared desktop files the same way `server.cjs` already
requires `desktop/src/intelio/*.cjs`; the VPS runs from a full checkout.

## Relay

- Started by `server.cjs` when `INTELIO_NODES=1` or the token file exists.
  `install-on-vps.sh` creates `~/.config/intelio/nodes-mcp.token` (mode 600, 32 random
  bytes, hex) if missing and writes `INTELIO_NODES=1` to `pwa.env`. It never prints the token.
- `/node/connect` is accepted on both listeners. Access listener (8644): a valid
  Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` header, or the `CF_Authorization`
  cookie) for an allowed email, checked by the same code as every other Access request.
  Tailnet listener (8643): the peer's Tailscale login must be in the allowed logins
  (`tailscale whois`), the same check as the phone app.
- Device secrets: 32 random bytes (hex) issued once; stored as a salted scrypt hash in
  `~/.config/intelio/nodes.json` (mode 600, written to a temp file and renamed).
- Per call: timeout `timeout_s` (run_command; default 120) + 10 s; an offline or
  disconnected computer gives `isError: true` with "<name> is offline (last seen …)".
- Audit: one stderr line per call (`intelio-nodes call computer=… tool=… args=… ok=… bytes=… ms=…`)
  that never holds file contents, command text (only program name and length) or secrets.
- MCP endpoint: `POST /mcp` only (GET/DELETE answer 405: no SSE, stateless), bearer
  required (401 otherwise), requests carrying an `Origin` header are refused (403) so a
  browser page cannot reach it. The bind must be the literal `127.0.0.1` or `::1` (no
  hostnames such as `localhost`, no wildcard or mapped-wildcard addresses); after binding
  the relay checks the socket's real address and closes it if it is not loopback. If the
  check fails the MCP endpoint stays off and the rest of the PWA keeps running.
  `desktop/test/intelio-node-relay.test.cjs` covers this, and a static check makes sure
  nothing under `desktop/src/intelio/node/` opens a listening port.

### Enroll, list, rename, revoke

Enrollment is automatic: the first time a signed-in intelio app connects, the relay
issues the device id and secret. Operators manage devices on the VPS:

```sh
node mobile/pwa/nodes-cli.cjs list            # name, id, os, user, last seen, revoked
node mobile/pwa/nodes-cli.cjs rename <name|id> <new name>
node mobile/pwa/nodes-cli.cjs revoke <name|id>
```

The relay watches `nodes.json`; a revoke disconnects a live device within about a second
and every later connect with that id is refused (`refused`, code `revoked`). The node then
stops dialing and shows "revoked" in Settings. After a revoke, turning the Settings toggle
off and on again forgets the device identity, so the next connect enrolls a NEW device (it still
needs the human check: Access sign-in or allowed tailnet login).

A VPS-side rename pins the name; until then the name follows the computer's Settings.

## Node (desktop app)

- Starts from `desktop/src/main.cjs` after the window opens, without awaiting anything.
- Target: Cloud mode → `wss://app.intelio-ai.com/node/connect` with the app's
  `CF_Authorization` cookie from the `persist:intelio-cloud` session. Tailscale mode →
  `wss://<host>:8643/node/connect`, falling back to `ws://` (the phone listener may or may
  not have a TLS cert). Not signed in / no host → waits and retries; signing in kicks it.
- Reconnect backoff 2 s doubling to 60 s (with jitter); WebSocket ping every 25 s.
- Identity: `{device_id, device_secret}` encrypted with Electron `safeStorage` in
  `<userData>/intelio-node/identity.bin`. If `safeStorage` is unavailable the node does
  not enroll (never stores the secret in plaintext) and Settings says why.
- Settings → "Let my agents use this computer" (default ON once the first-run prompt is
  allowed) and "Computer name" (default: OS hostname). OFF closes the socket immediately and
  refuses any in-flight call.
- Tailscale mode dialing a Tailscale IP verifies the phone listener's certificate against the
  peer's MagicDNS name (`tailscale status --json`, fallback the known VPS name) instead of
  failing the name check on the bare IP. Verification stays on.
- Audit: `<userData>/intelio-node/audit.jsonl`, one JSON line per call (time, tool, args
  summary without file contents, result bytes, exit code, ok/error).
- Elevation: commands matching sudo/doas/pkexec/su, runas, `Start-Process … -Verb RunAs`,
  `osascript … with administrator privileges` (and similar) are refused unless a native
  dialog on that computer is approved by the person there. Approval does not elevate:
  the command still runs as the user, and the OS shows its own UAC/sudo prompt.
- Executors: computer_info, list_dir, read_file, write_file, search_files (pure-Node
  walker in a worker thread: a slow regex on a huge line can no longer freeze the app; the
  time budget and the kill switch terminate it and partial matches are kept; OneDrive/iCloud
  cloud-only placeholders are skipped instead of downloaded; skips node_modules and .git
  unless the root is inside them), run_command
  (PowerShell on Windows, `$SHELL -lc` elsewhere; timeout kills the whole process tree),
  screenshot (`desktopCapturer` → PNG).
- Result shapes: tools return one text item holding JSON (fields as in the table above);
  `read_file` returns two text items: JSON metadata, then the content (text or base64).
- PowerShell receives the command as `-EncodedCommand` (same semantics as `-Command`,
  no quoting problems) with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`.
- Unsupported Linux desktop sessions: everything except `screenshot` works wherever
  Electron runs; `screenshot` needs a session `desktopCapturer` can read (and on macOS
  the Screen Recording permission).

## The "cloud" computer (the VPS itself)

- `mobile/pwa/nodes-local.cjs`: the relay serves "cloud" in-process with the same executors
  as a desktop node, as the VPS user the relay runs as. It adds no authority: agents already
  have their own shell on the VPS as that user. It exists so agents can address local, cloud
  or both with the same tools, and so the person gets the same kill switch and audit for it.
- Aliases: `cloud`, `vps`, `intelio-vps`, the VPS hostname. Listed first. Never elevates
  (sudo is refused with no prompt). Commands get the relay's environment minus intelio
  settings and anything named like a key, token, secret, password, credential, cookie or auth.
- `INTELIO_NODES_CLOUD=0` in `pwa.env` turns it off; `INTELIO_NODES_CLOUD_NAME` renames it.

## Person-only API (the app's Computers list)

`mobile/pwa/nodes-human.cjs`, mounted in `server.cjs`: `GET /api/computers`,
`POST /api/computers/pause {computer, paused}`, `GET /api/computers/audit?limit=N`.
Only a Cloudflare Access session (Access listener) or an allowed Tailscale login (tailnet
listener) is accepted. Profile bearer keys (which agents hold) are refused, a request from the
VPS itself is refused (agents run there), and POSTs must be same-origin. The desktop calls it
without any profile key (`computersRequest` in `remote-hermes-main.cjs`).

## First run, indicator, managed computers

- First run: the app asks once, "Let my agents use this computer?" (Allow is the default
  button). Until it is answered the node does not connect. Ticking the Settings box also
  answers it.
- While any agent call runs, a small always-on-top notice shows at the top of the screen
  ("intelio agent is using this computer · running a command") with Stop, which turns this
  computer's access off. It hides a few seconds after the last call. Settings shows the same.
- Managed computers: if the computer looks managed (Windows domain `*alliance*`, SentinelOne,
  or Cisco Umbrella installed) the node is HELD: it never connects and the first-run prompt is
  not shown. Settings explains why and offers "IT has cleared this computer for intelio"; only
  after that does the normal prompt/toggle apply. `INTELIO_NODE_HOLD=1` holds any computer
  regardless. A managed computer only ever dials intelio cloud (app.intelio-ai.com), never
  Tailscale. Detection only reads whether those tools are installed; nothing is changed,
  disabled or routed around.

## Stage 2: persistent terminal sessions (extension point, not implemented)

Goal: let the VPS agent run long interactive programs (Claude Code, Codex, a REPL) on a
computer and talk to them over several turns.

Planned tools (relay forwards them like any node tool; names reserved):

| tool | args | result |
|---|---|---|
| start_session | computer, command?, cwd?, cols?, rows? | session_id |
| send_input | computer, session_id, text, enter? | ok |
| read_output | computer, session_id, since?, wait_ms? | output (bounded), cursor, exited, exit_code |
| stop_session | computer, session_id | exit_code |

Where it plugs in:

- `protocol.cjs`: add the four entries to `TOOLS` (they become node tools automatically;
  `callTimeoutMs` should use `wait_ms` for `read_output`).
- `executors.cjs`: the executor table is `createExecutors(...)`'s return object; add the
  four handlers there, backed by a session map keyed by id (pty via `node-pty` or a piped
  child process; output ring buffer with a cursor; sessions die on kill switch OFF,
  disconnect timeout, or app quit).
- Elevation checks and the audit apply to `start_session` and `send_input` text the same
  way as run_command.
- No wire-protocol change is needed: calls stay request/response; `read_output` long-polls.
