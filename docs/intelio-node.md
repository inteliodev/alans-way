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
| list_computers | – | name, id, os, user, online, last_seen, version |
| computer_info | computer | os, arch, hostname, user, home, drives/volumes, shell |
| list_dir | computer, path, show_hidden? | entries: name, type, size, mtime (max 2000, truncated flag) |
| read_file | computer, path, offset?, limit?, encoding? (text\|base64) | content (text max 1 MB / base64 max 10 MB), total_size, truncated |
| write_file | computer, path, content, encoding? (text\|base64), mode? (create\|overwrite\|append, default overwrite), make_dirs? | bytes_written, path |
| search_files | computer, root, pattern (regex for content) ?, name_glob?, max_results? (default 200) | matches: path, line, text |
| run_command | computer, command, cwd?, timeout_s? (default 120, max 1800), shell? | exit_code, stdout, stderr (each max 200 KB, truncated flags), duration_ms |
| screenshot | computer, display? | MCP image content (PNG) + text with display size |
| start_session | computer, command?, cwd?, cols? (120), rows? (40), env? | session_id, pid, pty (bool), command, cwd |
| send_input | computer, session_id, text?, enter?, keys? | ok |
| read_output | computer, session_id, since?, wait_ms? (2000, max 30000), max_bytes? (64 KB), raw? | JSON: cursor, exited, exit_code, truncated, more; then the output text |
| stop_session | computer, session_id, force? | exit_code |
| list_sessions | computer | sessions: id, command, cwd, started, idle_s, exited |

The last five are the stage 2 terminal sessions; see "Stage 2: persistent terminal sessions" below.

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
describe how this repository implements it. Stage 2 (terminal sessions) is described at the end.

## Files

| piece | file |
|---|---|
| WebSocket (RFC 6455, stdlib) shared by node and relay | `desktop/src/intelio/node/ws.cjs` |
| Tool catalogue, limits, frames, audit summary (shared) | `desktop/src/intelio/node/protocol.cjs` |
| Node executors (files, search, commands, screenshot, session tools) | `desktop/src/intelio/node/executors.cjs` |
| Terminal sessions (PTY / pipes, ring buffer, limits) | `desktop/src/intelio/node/sessions.cjs` |
| Elevation detection | `desktop/src/intelio/node/elevation.cjs` |
| Node client (dial out, enroll, backoff, ping, audit, kill switch) | `desktop/src/intelio/node/client.cjs` |
| Electron glue (safeStorage, Settings, target URL, confirm dialog) | `desktop/src/intelio/node/electron.cjs` (started from `desktop/src/main.cjs`) |
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
- Per call: timeout `timeout_s` (run_command; default 120) + 10 s, `wait_ms` + 10 s for
  read_output (default 2 s, max 30 s); an offline or
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
- Result shapes: tools return one text item holding JSON (fields as in the table above);
  `read_file` returns two text items: JSON metadata, then the content (text or base64).
- PowerShell receives the command as `-EncodedCommand` (same semantics as `-Command`,
  no quoting problems) with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`.
- Unsupported Linux desktop sessions: everything except `screenshot` works wherever
  Electron runs; `screenshot` needs a session `desktopCapturer` can read (and on macOS
  the Screen Recording permission).

## Stage 2: persistent terminal sessions (implemented)

Goal: let the VPS agent run long interactive programs (Claude Code, Codex, a REPL, a shell)
on a computer and talk to them over several turns. Calls stay request/response on the
existing wire protocol; `read_output` long-polls. No relay change beyond the tool list and
the read_output timeout.

### Tools

| tool | args | result |
|---|---|---|
| start_session | computer, command?, cwd?, cols? (default 120), rows? (default 40), env? (NAME: value) | session_id, pid, pty, command, cwd, note? |
| send_input | computer, session_id, text?, enter?, keys? | ok, chars, keys, enter |
| read_output | computer, session_id, since?, wait_ms? (default 2000, max 30000), max_bytes? (default 64 KB, max 1 MB), raw? | text item 1: JSON session_id, cursor, exited, exit_code, truncated, more?, dropped_bytes?, bytes, pty; text item 2: the output |
| stop_session | computer, session_id, force? | session_id, exit_code, signal?, stopped |
| list_sessions | computer | sessions: id, command, cwd, started, idle_s, exited, exit_code, pty, pid, cursor |

- `command` omitted: the login shell (Windows: `powershell.exe -NoLogo` with the user's
  profile; macOS/Linux: `$SHELL -l`, fallback /bin/zsh, /bin/bash, /bin/sh). Given: it runs
  through the shell (Windows: `powershell -NoProfile -EncodedCommand`; macOS/Linux:
  `$SHELL -l -i -c` with a PTY so ~/.zshrc PATH changes such as nvm apply) and the session
  ends when the program exits.
- `send_input`: types `text` (newlines become Enter), then each named key, then Enter.
  `enter` defaults to true when there is text and false for keys-only calls. Keys: `ctrl-c`,
  `ctrl-d`, `esc`, `tab`, `up`, `down`, `left`, `right`, `enter`, `backspace`, plus
  `ctrl-a` … `ctrl-z`.
- `read_output`: the cursor is a byte offset into everything the session has printed; it
  only grows. `since` omitted continues after the last read (any reader); `since: 0` replays
  what is still buffered. Returns as soon as new text arrives (escape-only redraws do not
  count), else after `wait_ms`. `truncated` is true when bytes were lost to the ring buffer
  (`dropped_bytes`) or more is waiting (`more`: read again with the returned cursor).
  `exited`/`exit_code` are reported once the reader has caught up with the final output.
  Output is ANSI-stripped (colors, titles and modes dropped; cursor-forward becomes spaces,
  cursor positioning becomes a line break); `raw: true` keeps the escapes. This is not a
  terminal emulator: full-screen programs that redraw come out as a running log.
- `stop_session`: hang-up (SIGHUP to the process group), then SIGKILL after 3 s; `force`
  kills at once. Windows always ends the tree (`taskkill /T /F`). The session is forgotten.
  Sessions that exit on their own stay listed (and readable) until stopped, reaped or
  replaced.

### Limits and lifetime

- 1 MB output ring buffer per session; max 8 sessions per computer (a finished session is
  forgotten to make room; 8 running sessions refuse a 9th).
- A session with no send_input/read_output for 2 h is killed and forgotten.
- Every session is killed when Settings → "Allow intelio agents to use this computer" is
  turned OFF, when the computer is revoked on the VPS, and when the app quits. A network
  disconnect does NOT kill sessions; the agent can reconnect and keep reading.
- Elevation: the start `command` and every typed `text` go through the same check and
  native confirm dialog as run_command; refused text never reaches the terminal. Programs
  running in the session (for example Claude Code's own tools) are not inspected.
- Audit: one line per call in `<userData>/intelio-node/audit.jsonl` with a preview of the
  command / typed text (max 80 characters, secret-looking tokens such as `sk-…`, `ghp_…`,
  bearer tokens, `password=…`, `--token …` and long random strings masked). Output is never
  logged. The relay logs only the program name and text length (`text_chars`, `keys`).

### PTY

- `node-pty` 1.1.0 (Microsoft; N-API, so one binary works in Node and every Electron).
  Prebuilt binaries ship for win32-x64/arm64 (ConPTY) and darwin-arm64/x64; Linux builds it
  from source at `npm ci` (needs python3, make, g++).
- Windows NSIS (electron-builder): `asarUnpack: node_modules/node-pty/**` and
  `npmRebuild: false` (the N-API prebuild is used as is). sessions.cjs loads node-pty from
  `app.asar.unpacked` so its native addons and the ConPTY worker script are real files.
- macOS zip (electron-packager, `--no-asar`, built on Linux): only the darwin-arm64 prebuild
  is kept (the Linux build dir and Windows prebuilds are ignored). node-pty 1.1.0 ships
  `spawn-helper` without the execute bit, so `scripts/fix-node-pty.cjs` (prepackage) sets
  it, `zip -y` keeps it, and sessions.cjs re-applies it at runtime if needed.
- If node-pty fails to load or to spawn, the session runs as a piped child process and
  reports `pty: false` with a `note`. There is no terminal then: prompts that need a TTY,
  full-screen TUIs and line editing may misbehave or refuse to start; ctrl-c becomes SIGINT
  and ctrl-d closes stdin.

### Running Claude Code or Codex on a computer

1. `start_session` with `command: "claude"` (or `"codex"`), `cwd` set to the project.
2. `read_output` until the prompt shows. The first run on a computer may ask to sign in: the
   CLI prints a URL / device code inside the session; the person at the computer (or on their
   phone) approves it, then the agent continues reading. Trust-this-folder questions are
   answered with `send_input` (`keys: ["enter"]` or the option number).
3. `send_input` with the task text, then `read_output` with `wait_ms` up to 30000 in a loop,
   passing back the cursor, until the answer is complete. `keys: ["esc"]` interrupts Claude
   Code; `keys: ["ctrl-c"]` twice exits it.
4. `stop_session` when done (or let the 2 h idle timeout reap it).

For one-shot work, prefer `run_command` with `claude -p "…"` or `codex exec "…"`: no TUI, a
clean exit code and stdout, and nothing left running.

### Where it lives

- `protocol.cjs`: the five `TOOLS` entries, `LIMITS.session*`, `callTimeoutMs` for
  read_output, and the audit summary (`summarizeArgs`, `maskSecrets`).
- `sessions.cjs`: session map, PTY/pipe spawning, ring buffer, long poll, ANSI stripping,
  named keys, limits, idle sweep, `closeAll`.
- `executors.cjs`: the handlers (elevation check, path resolution) and `closeSessions`.
- `client.cjs`: kills all sessions on `stop()` (kill switch, app quit) and on revoke.
