> **Moved.** Development continues in the private repository `inteliodev/intelio-harness` (this repository is archived as of 2026-10-08).

# Hermes — Alan's Way

**Your AI agents live on a VPS. This gives them a window into your Mac — on your terms.**

A desktop app for people running [Hermes Agent](https://github.com/NousResearch/hermes-agent) on a Linux server who want to watch, steer, and lend their agents a local browser — without giving up the keyboard.

```
┌──────────────────────────────────────────────┐
│  Telegram chat on the left ──────────────┐   │
│                                          │   │
│  Bot-owned browser tabs on the right ────┤   │
│                                          │   │
│  ┌─────┐ ← your agent's cursor, labeled  │   │
│  └─────┘   and colored per bot           │   │
│                                          │   │
│  ┌──────────┐ ← draggable VPS desktop    │   │
│  │ mini VM  │   preview, click to take   │   │
│  └──────────┘   control                  │   │
└──────────────────────────────────────────────┘
```

## What you get

- **See every bot's cursor.** Each agent gets a colored, named cursor in its tabs. You can literally watch it click around.
- **Agents get their own browser, not yours.** Bot tabs are separate Chromium views — your mouse, keyboard, clipboard, and other apps are never touched.
- **Grab the wheel anytime.** "Take over" a tab and every queued agent action on it is cancelled instantly.
- **A window into the VPS.** A mini preview of your server's desktop floats in the corner. Drag it anywhere, hide it, or click to take control.
- **Shut your laptop, keep working.** With the [agent plugin](https://github.com/inteliodev/alans-way-agents), *new* browser work routes to the VPS when the Mac is unreachable. An in-flight Mac action fails visibly; its live tab stays on the Mac and can be inspected or resumed after reconnecting. Work already running on the VPS continues. (Backend checkpoint/restore plumbing exists, but the app exposes no cross-host handoff button yet.)
- **Explicit permissions.** Bots only see tabs you own or grant. Extension account pages are human-only. Nothing is shared unless you share it.

## The two repos

| Repo | What it is | Who installs it |
|---|---|---|
| **alans-way** (this one) | The Mac desktop app + companion CLI | You, on your Mac |
| [alans-way-agents](https://github.com/inteliodev/alans-way-agents) | The plugin: proactivity, workspace skill, auto-routing | Your Hermes gateway (VPS) |

The app works without the plugin (manual tab sharing), and the plugin falls back to VPS-only browsing when the app isn't running.

## How the pieces fit

- **Telegram stays stock.** Your existing Hermes gateway on the VPS keeps owning the bot conversation end to end. This app embeds the official Telegram Web client so you can chat and watch — it is not a second gateway and never polls the bot token.
- **Mac browser.** The app's own Chromium tabs are the bots' window into your Mac, driven per-tab through Chromium's debugger by a loopback-only connector.
- **VPS browser.** A separate managed Chromium on the server handles cloud work and is the fallback for *new* tasks when the Mac is asleep. It does not absorb in-flight Mac tabs — those block and resume.
- **VPS desktop preview.** Optional, and it needs a VNC server plus a noVNC (WebSocket) viewer you already run on the VPS — the app only embeds the viewer URL you paste in. Its **Take control** mode is the one place your input is forwarded to the remote desktop.
- **Plugin proactivity is read/research/draft by default.** The optional primary bot reviews its own work and drafts suggestions on a bounded budget; consequential actions (external messages, purchases, credential or permission changes, production changes, destructive operations) always require your approval.
- **No bundled account connections.** Email, calendar, Notion and similar tools exist only if you install and authorize them separately in Hermes — nothing here provisions them.

## Install the app

**Setting this up with an AI agent?** Point it at [docs/setup-for-agents.md](docs/setup-for-agents.md) — one page covering the Mac app, the VPS and the Hermes plugin, with a check after every stage and the exact steps that need you.

Requires an Apple Silicon Mac with git and Node 20+. One command builds the app,
installs it to `/Applications` and opens it; re-run it to upgrade:

```sh
curl -fsSL https://openalan.com/install-mac | sh
```

Sign into Telegram inside the app, and your existing bots appear in the sidebar.

For development, run from source instead: `cd desktop && npm ci && npm start`
(see the [desktop guide](desktop/README.md)).

## Connect your agents

In the app: **Settings → Agent setup** — the checklist shows what's already done.

1. Fill in both SSH addresses (your VPS, and how the VPS reaches this Mac — Tailscale name or IP).
2. Click **Copy setup command** and paste it in a terminal on the VPS — one bootstrap installs the plugin, wires the browser, restarts the gateway, and offers to bind your primary bot. (Never configured Telegram on Hermes? The bootstrap walks you through the QR-code setup.)
3. Click **Test agent path** — the app verifies VPS → Mac SSH end-to-end.

That's it. The bot gets a `workspace_browser` tool that opens tabs you can watch.

**Or let an agent do it.** If a Hermes agent already has a terminal on your VPS, paste it this prompt — it sets up Tailscale between the machines if needed, runs the same bootstrap, and reports back:

```text
Set up Alan's Way on this machine and connect it to my Mac.
1. If Tailscale isn't installed or connected here, install it
   (tailscaled + `tailscale up`). Tell me this machine's tailnet name/IP.
   My Mac's SSH address is: <your-mac-tailscale>
2. git clone https://github.com/inteliodev/alans-way-agents
3. Run: ./alans-way-agents/setup.sh --bot-id <your-telegram-bot-id> \
     --mac-ssh '<your-mac-tailscale>' --restart
   Answer its prompts; if it asks to bind a primary route, pick the bot
   matching this chat.
4. Then run ./alans-way-agents/setup.sh --verify and report the summary.
   If the VPS needs a desktop/VNC stack, tell me the exact apt commands —
   don't install it yourself.
```

The same prompt lives in [docs/setup-prompt.md](https://github.com/inteliodev/alans-way-agents/blob/main/docs/setup-prompt.md), and the plugin's `workspace-setup` skill teaches installed agents the playbook.

## Upgrading

Fresh installs and upgrades follow the same path: pull the repo, `cd desktop && npm ci`, restart the app. On the VPS, update the plugin checkout and restart the gateway through Hermes' normal lifecycle — a running gateway keeps old code until restarted. Then send one Telegram message and watch a bounded browser action to confirm both ends still work. See [deployment](docs/deployment.md) and the [multi-profile fleet guide](docs/agent-setup.md) for details.

## Honest boundaries

- **Alpha software.** Tested on the author's setup; yours may differ. Bugs → [issues](https://github.com/inteliodev/alans-way/issues).
- Agents think on the VPS. The Mac lends them a browser tab — it does **not** become their general-purpose computer.
- Agent input goes through Chromium's debugger into one tab — it never moves your real cursor or types into other apps.
- One exception: in the VPS preview, "Take control" mode *does* send your clicks to the remote desktop — that's the point of it.
- Telegram sending rides the embedded Telegram Web client. If sends stall, Settings → **Sync Telegram bots** reloads the session.

## Development

```sh
# Desktop app
cd desktop && npm ci && npm run check && npm start

# Companion CLI (optional — file tools + diagnostics)
python3 -m venv .venv && .venv/bin/pip install -e '.[mcp]'
.venv/bin/python -m unittest discover -s tests -v
```

Design docs live in [`docs/`](docs/) — [setup for agents](docs/setup-for-agents.md), [multi-profile fleets](docs/agent-setup.md), [security model](docs/mac-security.md), [integration](desktop/docs/integration.md).

## License

Desktop app: [GPL-3.0](desktop/LICENSE) · Companion CLI: [MIT](LICENSE) · Agent plugin: [MIT](https://github.com/inteliodev/alans-way-agents/blob/main/LICENSE)

Independent community project. Not affiliated with Nous Research.
