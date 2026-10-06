# Set up Alan's Way (instructions for an AI agent)

You are setting up three pieces for a human: the **Mac app** (alans-way-localapp),
the **VPS** that runs their Hermes gateway and a cloud browser, and the **Hermes
plugin** (alans-way-agents). Work through the stages in order. Each stage ends
with a check; do not continue past a failing check.

Some steps need the human. When you reach one, stop, tell them exactly what to
do using the wording given, and wait for them to confirm.

## What you need before starting

Ask the human for anything here you cannot discover yourself:

| Item | How to get it |
|---|---|
| Shell on the Mac | You are running on it, or have SSH to it |
| Shell on the VPS | `ssh <vps>` works, or you are running on it |
| Numeric Telegram bot ID | Digits only. The part before `:` in the bot token, or `getMe` on the token |
| Mac | Apple Silicon (`uname -m` prints `arm64`), macOS, Node 20+ and git |
| VPS | Linux, Hermes 0.21+ (`hermes --version`), Node 22+, python3, git |

Optional: the human's Telegram bot already answers messages through Hermes. If
not, stage 3 offers to set that up.

## Stage 1 — Mac app

```sh
curl -fsSL https://openalan.com/install-mac | sh
```

It clones the repo into `~/alans-way`, builds the app, installs it to
`/Applications/alans-way-localapp.app`, opens it, and ends with
`install-mac: running — local browser API answers (mac <version>)`. If it
stops on a missing tool, it names the fix (Node 20+, git); install that and
re-run. A locally built app is not quarantined, so macOS shows no Gatekeeper
warning. Re-run the same command to upgrade; sign-ins and settings live outside
the app bundle and are kept.

**Human step — tell them:** "The Alan's Way app is open. Sign in to Telegram in
the left pane with the QR code (Telegram on your phone → Settings → Devices →
Link Desktop Device). Tell me when your bots appear in the sidebar."

**Check:** the app's local browser API answers.

```sh
node -e 'const c=require(process.env.HOME+"/Library/Application Support/Hermes Workspace/connection.json");fetch(c.url+"/v1/status",{headers:{Authorization:"Bearer "+c.token}}).then(r=>r.json()).then(s=>console.log(s.host,s.version))'
```

Expect `mac` and a version number.

## Stage 2 — Let the VPS reach the Mac over SSH

The VPS drives the Mac browser through SSH, so the Mac needs Remote Login and
a private network address the VPS can reach (Tailscale recommended).

**Human step — tell them:**
1. "Open System Settings → General → Sharing and turn on **Remote Login**."
2. "Install Tailscale on the Mac from tailscale.com/download and sign in with
   the same account the VPS uses." (Skip if `tailscale status` already works
   on both machines.)

Then collect `MAC_SSH` = `<mac-user>@<mac-tailscale-name>`. Get the user with
`whoami` on the Mac and the name with `tailscale status --self` (first line).
Also collect `MAC_TZ`, the human's timezone for the bot's quiet hours:
`readlink /etc/localtime | sed 's#.*zoneinfo/##'` on the Mac (for example
`Europe/Berlin`).

On the VPS, install a key and record the Mac's host key (the browser tools
connect with `BatchMode=yes` and `StrictHostKeyChecking=yes`):

```sh
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519
ssh-copy-id -o StrictHostKeyChecking=accept-new "$MAC_SSH"
```

`ssh-copy-id` asks for the Mac login password once. If you have a shell on
the Mac, append the VPS's `~/.ssh/id_ed25519.pub` to the Mac's
`~/.ssh/authorized_keys` yourself instead.

**Check, from the VPS:**

```sh
ssh -o BatchMode=yes "$MAC_SSH" 'test -x /Applications/alans-way-localapp.app/Contents/MacOS/alans-way-localapp && echo MAC_OK'
```

Expect `MAC_OK`. The VPS runs the browser connector with the app's own
runtime, so the Mac needs no Node on its SSH PATH. If nothing prints, the app
is not in `/Applications` — repeat stage 1.

## Stage 3 — VPS: Hermes plugin and cloud browser

On the VPS:

```sh
git clone https://github.com/inteliodev/alans-way-agents ~/alans-way-agents || git -C ~/alans-way-agents pull
~/alans-way-agents/setup.sh --bot-id <BOT_ID> --mac-ssh "$MAC_SSH" --timezone "$MAC_TZ" --restart
```

The script is safe to re-run. It installs the plugin and gateway hook, clones
this repository for the cloud browser, writes the browser services, configures
the `workspace_browser` connector, restarts the gateway and offers to bind the
primary bot. Answer its prompts:

- "Run 'hermes gateway setup' now?" appears only when no Telegram bot token is
  configured. Say yes, then **human step — tell them:** "Scan the QR code shown
  in the terminal with Telegram to create or link the bot."
- "Bind a primary route?" — pick the bot this setup is for. If it says there
  are no Telegram DM sessions yet, ask the human to send the bot one message,
  then run `~/alans-way-agents/setup.sh --bind --timezone "$MAC_TZ"`.
- "Turn proactive messages on now?" — do not answer this yourself.
  **Human step — ask them:** "Should your bot be allowed to message you first,
  with check-ins and follow-ups (at most a few a day, never 22:00–08:00)?" Answer
  with their choice. If they say no, they can send `/proactivity resume` later.

If it prints `no Xvfb/x11vnc detected`, the cloud browser has no display yet.
Do not install a desktop stack on your own. **Human step — tell them:** the
exact `apt-get install` line it printed, and ask whether to install it. The
browser services start once a display on `:99` exists.

**Check:**

```sh
~/alans-way-agents/setup.sh --verify
```

Expect `setup: all required checks passed`. Report every `warn` line to the
human.

## Stage 4 — Prove it end to end

1. In the Mac app: **Settings → Agent setup**, enter the VPS SSH address and
   `MAC_SSH`, click **Save addresses**, then **Test agent path**. Success text
   starts with "VPS reaches this Mac over ssh".
2. **Human step — tell them:** "In the Alan's Way app, message your bot:
   *Open example.com in the workspace browser and tell me the page title.*"
   Expect a tab with the bot's named cursor to appear on the right and the bot
   to reply "Example Domain".
3. **Human step — tell them:** "Send `/proactivity status` to the bot." Expect
   it to report the route as bound, and on if they chose proactive messages.

Report to the human: what passed, every warning, and anything you skipped.

## Optional — watch the VPS desktop from the Mac

Requires the display stack from stage 3 plus a noVNC viewer on the VPS that the
Mac can reach over Tailscale. Paste the viewer URL into **Settings → VPS
desktop connection** in the app.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Stage 1 check: `Cannot find module …connection.json` | The app is not running or never started its API. Open it and retry. |
| `Host key verification failed` | The Mac's host key is not in the VPS's `known_hosts`. Re-run the `ssh-copy-id -o StrictHostKeyChecking=accept-new` line. |
| Verify says `workspace_browser timeout …s is below 120s` | Long browser actions get cut off. Re-run stage 3 setup, or set `timeout: 120` on the block and restart the gateway. |
| Bot opens tabs on the VPS while the Mac is awake | The Mac app is closed, or SSH from the VPS fails. Re-run the stage 2 check. |
| Browser tool errors right after setup | The gateway is still running old code. `hermes gateway restart`. |
| `handoff_review_required` | A page moved between computers needs the human to check it, for example a login. Ask them. |

More detail: [deployment](deployment.md), [VPS browser](../desktop/docs/vps-browser.md),
[security model](mac-security.md), and the plugin's
[setup prompt](https://github.com/inteliodev/alans-way-agents/blob/main/docs/setup-prompt.md).
