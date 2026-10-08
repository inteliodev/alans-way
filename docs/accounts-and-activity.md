# Accounts page and activity log

Both live in the intelio plugin layer (the PWA server and the desktop/phone UI). They read Hermes state but never write it. They don't patch Hermes, don't write its config, and don't restart the gateway.

## Accounts page

You can find it in the desktop agent tab (Computer · Details · Memory · Phone · **Accounts**) and in the phone agent sheet.

| Group | What it shows | How it is detected |
| --- | --- | --- |
| Model sign-in | Provider, model, plan label, last successful call | `provider`/`model`/`base_url` from the profile `config.yaml`. The profile's `auth.json` (or the shared `~/.hermes/auth.json`) is checked only for **existence and mtime**, never opened. The last successful call comes from `session_model_usage` in the profile `state.db`, which is opened read-only. |
| Claude Code | One row per config dir (`~/.claude`, `~/.claude-<name>`) | `claude auth status` with `CLAUDE_CONFIG_DIR` set: `loggedIn`, `email`, `subscriptionType`, `authMethod` |
| Codex CLI | One row per `~/.codex`, `~/.codex-<name>` | `codex login status` with `CODEX_HOME` set |
| GitHub | One row per `~/.config/gh`, `~/.config/gh-<name>` | `gh auth status` with `GH_CONFIG_DIR` set. Account and scopes only; token-like strings are stripped |
| Messaging | Telegram, SMS (Twilio), iMessage (Photon) | Variable **names** from the profile `.env` (the file is parsed for names only; values are discarded and never returned, logged or cached), plus state from `~/.hermes/gateway_state.json` |
| MCP servers and plugins | `mcp_servers` and `plugins` from `config.yaml`, plus installed plugin dirs | Config is line-parsed. Only names and the enabled flag are kept |
| Computer | Bot desktop/browser | `bot-desktop/launcher.pid` is alive or `cdp.url` exists, and the browser profile dir exists |
| Saved logins | Count | The vault's own list (site and username only) |
| Client apps (desktop only) | Microsoft 365 / Google Workspace browser sign-in | The desktop app's existing `client-apps-status` |

Status commands run with `execFile` (no shell) and a minimal environment: `HOME`, `PATH`, `USER`, `LANG`, `NO_COLOR`, `TERM=dumb`, `GH_PROMPT_DISABLED`. No server secrets or `GH_TOKEN` are passed. Every string in the response goes through the activity-log redactor before it leaves the server. Results are cached for 60 s per agent.

### Multiple accounts

- Claude Code uses `CLAUDE_CONFIG_DIR=~/.claude-<name>`.
- Codex uses `CODEX_HOME=~/.codex-<name>`.
- GitHub uses `GH_CONFIG_DIR=~/.config/gh-<name>`. This is a separate gh config rather than `gh auth switch`, which would change the active account for every agent.

"Sign in another account" starts the CLI's own login in a detached tmux window (session `intelio-accounts`) on the server:

- `claude auth login --claudeai`
- `codex login --device-auth`
- `gh auth login --web`

The app shows the sign-in URL (only accepted from each tool's own hosts) and the device code. For Claude, a masked field sends the pasted code to that tmux window through a tmux buffer on stdin. The code is never put on a command line, logged, or stored. When the status command confirms the sign-in, or after 10 minutes, the window's history is cleared and the window is closed.

"Use for this agent" writes `~/.config/intelio/accounts.json` (mode 600):

```json
{ "version": 1, "profiles": { "prc": { "claude": "work", "codex": "default", "github": "default" } } }
```

Hermes doesn't read this file. intelio features (terminals, the computer connector) get the environment for an agent from `accounts.envFor(profile)` → `{ CLAUDE_CONFIG_DIR, CODEX_HOME, GH_CONFIG_DIR }`.

### API

All routes use the same auth as the rest of the PWA API (Access JWT or keyed bearer on the cloud listener, Tailscale identity on the tailnet listener). POSTs also need a bearer or a same-origin request.

| Route | Purpose |
| --- | --- |
| `GET /api/accounts?profile=<id>[&fresh=1]` | Status rows for one agent (no secrets) |
| `POST /api/accounts/signin` `{profile, tool, name}` | Start a sign-in (`tool` = `claude`, `codex`, `github`) |
| `GET /api/accounts/signin?id=<id>` | Sign-in progress: URL, device code, state |
| `POST /api/accounts/signin/code` `{id, code}` | Send Claude's paste-back code to the sign-in window |
| `POST /api/accounts/signin/cancel` `{id}` | Stop a sign-in |
| `POST /api/accounts/assign` `{profile, tool, account}` | Set which account an agent uses |
| `GET /api/activity?agent=&kind=&q=&limit=` | Activity rows, newest first |

## Activity log (Settings › Activity)

The section stays collapsed until you open it. There are no notifications and nothing on the main screen.

Sources:

1. Hermes session history: `profiles/<id>/state.db` opened read-only. Terminal commands are classified as `github` (git push, gh pr, gh …), `claude`, `codex`, or `terminal`. Browser sign-ins are `browser`, vault fills are `vault`, and computer actions are `connector`.
2. intelio's own append-only log at `~/.config/intelio/activity.jsonl` (mode 600, rotates at 8 MB).

Other intelio features append with `desktop/src/intelio/activity-log.cjs`:

```js
const { appendActivity } = require('./activity-log.cjs');
appendActivity({ profile: 'prc', kind: 'connector', action: 'open', summary: 'Opened a terminal on the Mac', actor: 'agent' });
```

`appendActivity` never throws. Schema v1, one JSON object per line:

| Field | Notes |
| --- | --- |
| `v` | `1` |
| `ts` | ISO-8601 UTC |
| `profile` | agent slug, or `''` |
| `kind` | `github` `claude` `codex` `terminal` `browser` `connector` `vault` `signin` `account` `other` |
| `action` | short verb, `[a-z0-9-]` |
| `summary` | one line, at most 300 chars, redacted |
| `account`, `ok`, `actor`, `session`, `tool` | optional |
| `source` | `intelio` (this file) or `hermes` (read from transcripts) |

Redaction runs on write and again on read. It covers private keys, Authorization headers, bearer tokens, GitHub/OpenAI/Slack/AWS/Google key shapes, JWTs, credentials in URLs, `--password`-style flags, secret-named `KEY=value` pairs, OAuth query parameters, and long random-looking strings.
