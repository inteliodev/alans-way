# intelio workspace

Cursor-style "cloud agents" workspace on the VPS. Hermes Agent (profile `builder`) is the only
driver: every task is a git worktree + branch with its own tmux session, and each message runs
`hermes -p builder chat --format stream-json` in that worktree.

- URL: https://intelio-vps.tail9c1007.ts.net:8670/ (tailnet only, Tailscale identity `inteliodev@github`;
  requests from the VPS itself are refused so agents cannot drive the API). `?theme=dark|light`, `?task=<id>`, `?tab=changes|desktop|terminal|files`.
- Service: `systemctl --user {status,restart} intelio-workspace` (MemoryMax 1.5G, CPUQuota 150%, KillMode=process so
  tmux sessions survive restarts). Logs: `logs/server.log`, `logs/stdout.log`.
- Data: `data/tasks.json`, `data/runs/<id>.jsonl` (raw event stream + markers), `data/status.json`, `data/models.json` (probe results).
- Worktrees: `~/workspaces/repos/<repo>` (no-checkout clones), `~/workspaces/tasks/<id>`, tmux socket `tmux -L intelio-ws`.

## Push policy (only main asks)

- Agents may commit, push feature branches and open/update PRs.
- `~/workspaces/hooks/pre-push` (per-worktree `core.hooksPath`) refuses pushes to the default branch / main / master
  unless a one-time grant `~/workspaces/grants/<id>` + nonce exists.
- `~/workspaces/bin/gh` (first on the agent PATH) refuses `gh pr merge`, `gh repo sync`, and `gh api` merge / default-branch
  ref writes without that grant. `~/workspaces/bin/git` refuses `push --no-verify` and hooksPath overrides.
- "Merge to main…" in the UI is the only approve-gated action (confirm dialog → grant → `gh pr merge` → grant removed).
- Sources of the hook/wrappers are in `deploy/`.

## Models / helpers

- Picker lists Hermes providers (`hermes -p builder auth status <provider>`) and models; ✓/✕ = probe result.
- Sign-in commands (run on the VPS): anthropic `hermes -p builder auth add anthropic`, xAI `hermes -p builder auth add xai --type api-key`,
  OpenRouter `hermes -p builder auth add openrouter --type api-key`, Cursor `NO_OPEN_BROWSER=1 ~/.local/bin/cursor-agent login`.
- Helpers (Codex, Claude Code, Cursor) are skills in the builder profile; per-task checkboxes tell Hermes which it may use.

## Install / deploy (from this repo)

This folder is the source of truth (it used to live only in `~/intelio-workspace` on the VPS). The
service still runs from its runtime folder `~/intelio-workspace`, which holds the state that is not
in git: `data/`, `logs/`, `node_modules/`, `static/vendor/` and `config.env`. Deploy from the VPS
checkout of this repo:

```sh
cd "$(systemctl --user show -p WorkingDirectory --value intelio-pwa.service)"
git pull
bash workspace-service/deploy/install-on-vps.sh            # --dry-run prints what it would do
```

The script copies the code into `~/intelio-workspace` (never deletes, never touches the state above),
installs `deploy/hooks` + `deploy/bin` into `~/workspaces/`, the `builder-skills/` into the builder
profile, and `intelio-workspace.service` into `~/.config/systemd/user/`, then restarts
`intelio-workspace.service` only. `KillMode=process` keeps running task tmux sessions alive.
`npm ci` runs only when `package-lock.json` changes. First install: copy `config.env.example` to
`~/intelio-workspace/config.env` (the script does this when it is missing) and check `WS_BIND`.

## In the intelio app

The intelio app (desktop window, `/desktop` in a browser, and the phone client) has a **Workspace**
page that embeds `https://intelio-vps.tail9c1007.ts.net:8670/?embed=intelio&theme=<light|dark>`
(`desktop/src/intelio/pages.cjs`). The server sends no `X-Frame-Options` or `frame-ancestors`, so
it can be framed by the app; access is still decided by the caller's Tailscale identity.

## Dev

`npm install && npm run vendor` (copies xterm.js into `static/vendor`). No build step.
