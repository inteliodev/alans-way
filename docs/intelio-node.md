# intelio node — interface contract (v1)

Goal: from the phone or any computer, the intelio agent on the VPS can use every enrolled
computer (files, search, commands, screenshots) as that computer's signed-in user.
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
     (env `INTELIO_NODES_MCP_PORT`, default 8645, loopback bind only; never 0.0.0.0).
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

## Tools (names are final; Hermes exposes them as mcp_intelio_computers_<name>)

Every tool except `list_computers` takes `computer` (device name or id, case-insensitive).
Offline computer -> tool result `isError: true` with text "<name> is offline (last seen …)".

| tool | args | result |
|---|---|---|
| list_computers | – | name, id, os, user, online, last_seen, version |
| computer_info | computer | os, arch, hostname, user, home, drives/volumes, shell |
| list_dir | computer, path, show_hidden? | entries: name, type, size, mtime (max 2000, truncated flag) |
| read_file | computer, path, offset?, limit?, encoding? (text\|base64) | content (text max 1 MB / base64 max 10 MB), total_size, truncated |
| write_file | computer, path, content, encoding? (text\|base64), mode? (create\|overwrite\|append, default overwrite), make_dirs? | bytes_written, path |
| search_files | computer, root, pattern (regex for content) ?, name_glob?, max_results? (default 200) | matches: path, line, text |
| run_command | computer, command, cwd?, timeout_s? (default 120, max 1800), shell? | exit_code, stdout, stderr (each max 200 KB, truncated flags), duration_ms |
| screenshot | computer, display? | MCP image content (PNG) + text with display size |

Paths: absolute, or `~`-relative to the user's home. Shell: Windows = PowerShell
(`powershell.exe -NoProfile -NonInteractive -Command`), macOS/Linux = `$SHELL -lc` (fallback /bin/zsh, /bin/bash).

## Authority (access is broad; authority is not)

- Node runs with the OS account's rights only. It never elevates.
- Commands that request elevation (`sudo`, `runas`, `Start-Process … -Verb RunAs`,
  `osascript … with administrator privileges`) are refused with a clear message unless the
  user approves a native confirm dialog on that computer.
- Kill switch: Settings → "Allow intelio agents to use this computer" (default ON after the
  user enrolls; OFF disconnects immediately).
- Audit: node appends every call (time, tool, args summary without file contents, result size,
  exit code) to `<userData>/intelio-node/audit.jsonl`; relay logs the same summary.

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
| Electron glue (safeStorage, Settings, target URL, confirm dialog) | `desktop/src/intelio/node/main.cjs` |
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
  browser page cannot reach it. Bind must be loopback; anything else throws at start.

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
stops dialing and shows "revoked" in Settings. Turning the Settings toggle off and on
again forgets the device identity, so the next connect enrolls a NEW device (it still
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
- Settings → "Allow intelio agents to use this computer" (default ON) and "Computer name"
  (default: OS hostname). OFF closes the socket immediately and refuses any in-flight call.
- Audit: `<userData>/intelio-node/audit.jsonl`, one JSON line per call (time, tool, args
  summary without file contents, result bytes, exit code, ok/error).
- Elevation: commands matching sudo/doas/pkexec/su, runas, `Start-Process … -Verb RunAs`,
  `osascript … with administrator privileges` (and similar) are refused unless a native
  dialog on that computer is approved by the person there. Approval does not elevate:
  the command still runs as the user, and the OS shows its own UAC/sudo prompt.
- Executors: computer_info, list_dir, read_file, write_file, search_files (pure-Node
  walker; skips node_modules and .git unless the root is inside them), run_command
  (PowerShell on Windows, `$SHELL -lc` elsewhere; timeout kills the whole process tree),
  screenshot (`desktopCapturer` → PNG).

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
