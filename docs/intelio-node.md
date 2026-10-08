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

Streamable HTTP, JSON responses: `POST /mcp` with JSON-RPC 2.0;
methods `initialize`, `notifications/initialized` (202, no body), `tools/list`, `tools/call`,
`ping`. One exception: a `tools/call` that pushes answers as an SSE stream that first carries an
`elicitation/create` request (see "Pushes and secrets"); the client POSTs the JSON-RPC response
back (202) and the stream then ends with the tool result. Missing/wrong bearer -> HTTP 401. Protocol version: echo the client's requested
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

## Pushes and secrets (Hayden, Oct 8 2026: "It can read and drive on computers yes anything push is an approval")

Reads, file changes, commands and driving the computer run without asking. Two exceptions:

**A push asks Hayden first.** `run_command` text (and, with terminal sessions, `start_session` /
`send_input` text) is checked for pushes with `desktop/src/intelio/node/policy.cjs` `findPushes`:
`git push` (any form, incl. `git -C`, `--no-verify`, inside `sh -c` or `ssh host`), `git lfs/subtree
push`, `gh pr merge`, `gh repo sync`, `gh repo create --push`, `gh release create`, and `gh api`
writes to refs, merges, contents or releases. The relay (`mobile/pwa/nodes.cjs` `askPush`) asks
through MCP elicitation, so Hermes shows its own approval prompt on the surface Hayden is using:
an inline Allow / Don't allow row in the intelio app (desktop and phone,
`desktop/src/intelio/approval-ui.cjs`) or the approval buttons in Telegram. Allow covers that one
command once. Don't allow, no answer within `INTELIO_PUSH_APPROVAL_WAIT_S` (150 s), a client that
cannot elicit, or any error refuses it with a message telling the agent not to retry another way.
On allow the relay stamps the call (`push_approval`); it drops any stamp an agent sends. The
computer refuses a push without the stamp, so an older relay can never push. On "cloud" an
approved push also gets a one-time grant for the VPS push guard (alans-way-agents
`push-approval`). Every decision is audited (`tool: push_approval`, note allowed / declined /
unanswered / unavailable) and goes to the intelio activity log when
`desktop/src/intelio/activity-log.cjs` is present (`kind: connector`, `action: push`).

**Secrets are never read or written.** `read_file`, `write_file` and `search_files` refuse
protected paths, checked as given and by real path (symlinks): SSH private keys (public keys,
`known_hosts`, `config` and `authorized_keys` stay readable; nothing in `~/.ssh` is writable),
`~/.gnupg`, keychains, browser cookie and password stores (`Cookies`, `Login Data`, `key4.db`,
`logins.json` ...), `~/.aws/credentials`, gcloud/azure, `gh` `hosts.yml`, `.git-credentials`,
`.netrc`, `.npmrc`, `.pypirc`, docker/kube configs, Claude and Codex logins, `~/.config/intelio`,
the push grants, `$HERMES_HOME/.env` and `auth.json` (and each profile's), `/etc/shadow`,
`gshadow`, `sudoers`, SSH host keys, `/etc/ssl/private`, `/root`, macOS `dslocal`, Windows
Credentials / Protect / Vault and `System32\config` (SAM, SECURITY). A search walks past them.
Commands that name one (`cat ~/.ssh/id_ed25519`, `cp ~/.hermes/.env /tmp`) are refused too; `ssh -i
KEY` and `ssh-add` use a key without showing it and are allowed. The command check is best
effort: a script can still reach a file without naming it. The list and the containment check
are adapted from Herald OS `bridge/permissions.py` (MIT, Copyright (c) 2026 Luke The Dev).

Limits: a push started indirectly (a script, `npm run release`, a coding tool run through
`run_command`) is not seen on a personal computer, because the node checks the command text, not
what it starts. On the VPS the push guard covers that case.

Terminal sessions: `start_session` checks its command like `run_command`. `send_input` checks the
line typed so far (since the last Enter, Ctrl-C, Ctrl-U or Ctrl-D), so `git pu` then `sh` is still
refused; a push must be typed whole in one `send_input` (the relay asks about that text). On "cloud"
an approved push typed into a shell is prefixed with `export INTELIO_PUSH_GRANT=<id>; `, so the
grant id shows in that session's output and stays set in that shell; the grant itself is used up
by the push and expires after 15 minutes. A push started from inside a session's program (for
example Claude Code running `git push` itself) is not seen on a personal computer.

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
- Per call: timeout `timeout_s` (run_command; default 120) + 10 s, `wait_ms` + 10 s for
  read_output (default 2 s, max 30 s); an offline or
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
- Linux without node-pty (the VPS relay, whose checkout has no desktop `node_modules`):
  util-linux `script -qfec … /dev/null` gives the program a real terminal (a `/dev/pts`
  device, line discipline, ctrl-c as SIGINT); the session reports `pty: true`. The size is
  set once at start (`stty`); later resizes are not applied.
- Packaged proof: `intelio --smoke-test --node-pty` (`src/intelio/node/pty-smoke.cjs`) runs
  a session through the same executor path the agents use and requires `pty: true`, a shell
  that really ran, on macOS a `/dev` tty, and on Windows node-pty loaded from
  `app.asar.unpacked`. `windows-installer.yml` runs it on the NSIS build and on the macOS
  zip on a real Mac.
- If node-pty fails to load or to spawn (and there is no `script`), the session runs as a piped child process and
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

### Finding Claude Code and Codex

`computer_info` returns `coding_tools: { claude, codex }` (path or null), found on the
app's PATH plus the usual install folders (`~/.local/bin`, `~/.claude/local`, npm global,
Homebrew, `%APPDATA%\npm`, …) without running anything, and `sessions: { pty, hint }`.

### The person's Terminal window

Settings → This computer → Open Terminal opens a window with two tabs: **This computer**
and **cloud** (the VPS). These are the person's own terminals (xterm.js, raw keystrokes,
raw output, resize). Agents cannot see or type into them, and the agents' kill switch does
not end them.

- This computer: a session manager in the app's main process (`src/intelio/terminal/main.cjs`).
- cloud: `POST /api/computers/terminal/{start,input,read,resize,stop}` and
  `GET /api/computers/terminal/list` on the relay (`mobile/pwa/nodes-terminal.cjs`), behind
  the person-only checks of `nodes-human.cjs` (Access session or allowed Tailscale login;
  never a profile key; never the VPS itself; same-origin POSTs). The app calls them through
  its existing cloud session / Tailscale path without a key. Up to 4 sessions, 1 h idle.
  `INTELIO_CLOUD_TERMINAL=0` in `pwa.env` turns the routes off.
- The window's renderer is sandboxed with one IPC channel that answers only that window.

### Where it lives

- `protocol.cjs`: the five `TOOLS` entries, `LIMITS.session*`, `callTimeoutMs` for
  read_output, and the audit summary (`summarizeArgs`, `maskSecrets`).
- `sessions.cjs`: session map, PTY/pipe spawning, ring buffer, long poll, ANSI stripping,
  named keys, limits, idle sweep, `closeAll`.
- `executors.cjs`: the handlers (elevation check, path resolution) and `closeSessions`.
- `client.cjs`: kills all sessions on `stop()` (kill switch, app quit) and on revoke.
