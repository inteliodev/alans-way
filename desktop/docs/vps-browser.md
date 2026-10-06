# Native VPS browser host

This optional add-on leaves stock Hermes unchanged. One graphical Chromium
profile supplies live shared sign-ins; each managed tab opens in a separate
window and belongs to a bot ID. Agents use tab-specific Chromium input rather
than the desktop mouse. The Mac displays those windows through its existing
noVNC connection. It is one shared desktop, not separate desktop streams.

## Provision the browser

Use Node 22+ on the VPS, a working X11 desktop/VNC viewer, and an installed GUI
Chromium. Install this repository in a stable directory and run
`npm ci --omit=dev --ignore-scripts` in `desktop/`. The examples below assume
`git clone https://github.com/inteliodev/alans-way /opt/hermes-alans-way/browser`
(the plugin's `setup.sh` uses the same path when run as root). Keep Hermes' Python environment
and dependencies separate. Use a dedicated browser profile; existing browser
windows/profiles need not be altered.

Choose a private data directory owned by the desktop user, mode 0700. By default
it is `~/.local/share/hermes-alans-way/browser`; `HERMES_VPS_BROWSER_DATA` can
override it for both services and the SSH request command. Create mode-0600
`config.json` there, replacing executable/profile paths for your installation:

```json
{
  "port": 9465,
  "cdpUrl": "http://127.0.0.1:9223",
  "browserCommand": "/usr/bin/chromium",
  "browserArgs": [
    "--user-data-dir=/home/user/.local/share/hermes-alans-way/chromium",
    "--remote-debugging-port=9223",
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--start-maximized",
    "about:blank"
  ]
}
```

Prefer running Chromium as an ordinary desktop user with its sandbox enabled.
The desktop user is not root. Broker port 9465 and Chromium CDP port 9223 stay
on `127.0.0.1`; the host refuses a public bind or a remote-debugging address
other than `127.0.0.1`.

Intelio safety uses the same rules as the Mac app. Set `INTELIO_SIDECAR` or
`intelioSidecar` in `config.json` to an `alans-way.yaml` path. If neither is
set, the host uses the strict defaults (no YOLO, consequential actions
ask-first, no extra browsing zone). `INTELIO_YOLO` is ignored. A sidecar with
`yolo: true` or a consequential mode other than `ask` refuses to start. Agent
opens and navigations to payment hosts or `/checkout`, `/payment`, and
`/billing` return `approval_required`. A non-empty `browsing_origins` list
denies every other origin. Human navigation is not zone-gated. Clone this
fork (`intelio/forks.json`), not the upstream repository.


Snap installations require a profile path inside their permitted user data
directory. Match `DISPLAY` and session environment to the VNC desktop. Both
debugging and broker ports must remain loopback-only; SSH transports commands.
The new profile needs its own initial sign-in on this host.

## Keep Chrome and the broker independent

For systemd, install these two units with your actual user, display, Node and
repository paths. The Chromium supervisor detects an already running browser
instead of repeatedly invoking a launcher that returns after attaching to it.
That avoids restart loops and unwanted blank windows. Ensure your desktop
session starts before these units.

`hermes-alans-way-chromium.service`:

```ini
[Unit]
Description=Hermes Alans way managed Chromium
After=network.target

[Service]
Type=simple
User=desktop
Environment=DISPLAY=:99
ExecStart=/usr/bin/node /opt/hermes-alans-way/browser/desktop/scripts/vps-chromium-host.cjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`hermes-alans-way-browser.service`:

```ini
[Unit]
Description=Hermes Alans way browser tab broker
After=hermes-alans-way-chromium.service
Requires=hermes-alans-way-chromium.service

[Service]
Type=simple
User=desktop
Environment=DISPLAY=:99
Environment=INTELIO_SIDECAR=/opt/hermes-alans-way/browser/intelio/profiles/example/alans-way.yaml
ExecStart=/usr/bin/node /opt/hermes-alans-way/browser/desktop/scripts/vps-browser-host.cjs serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Reload systemd and enable/start both units through your normal service setup.
The broker writes private `connection.json` and `tabs.json` in its data
directory. Never commit these files. Restarting only the broker reconnects
existing live targets, increments control epochs and returns them to human
control. Chromium exit loses the live target/page memory; retained URLs alone
are not a restored task. Inspect pages before retrying uncertain submissions.

## Connect stock Hermes and the Mac

Merge this native MCP entry into each profile, preserving existing entries:

```yaml
mcp_servers:
  workspace_vps_browser:
    command: /usr/bin/node
    args:
      - /opt/hermes-alans-way/browser/desktop/scripts/browser-mcp.cjs
      - --bot-id
      - YOUR_NUMERIC_TELEGRAM_BOT_ID
      - --connection
      - /home/user/.local/share/hermes-alans-way/browser/connection.json
    lazy: true
    connect_timeout: 10
    timeout: 100
```

Keep `timeout` above 90 seconds: a `batch` action may run for up to about 80
seconds before it answers, and the connector waits 90 seconds for actions.

Run the connector as a user allowed to read that private connection file.
Use Hermes' supported gateway/MCP reload workflow, then verify a full agent
turn. Native VPS open defaults to this host; an explicit Mac open fails
visibly. Retain the existing SSH-to-Mac `workspace_browser` entry for local
work. Install the repository's `workspace-operations` skill in the profile's
native user skills directory for host selection and takeover instructions.

The Mac app needs only **Settings → VPS desktop connection** and a reachable
noVNC viewer URL for watching/control. It does not list or create VPS browser
tabs. Configure native VPS tools in Hermes as above; the broker's private token
remains on the VPS. Existing private `vpsBrowser` preferences can still supply
SSH routing to the optional Mac connector/backend handoff path; its settings
are no longer exposed in the UI.

## Verify and recover

Check native status reports `host: vps`. Open a disposable tab through the
agent connector, take a fresh snapshot, type/click only its fixture and inspect
the resulting page. Verify another bot cannot list/read that tab. Explicit
cross-bot grants and recovery of human-controlled VPS targets require an
authorized broker controller; the Mac's local ⇄ dialog manages local tabs only.
Test desktop **Take control / Stop control** independently. Backend handoff
details and its destination review requirement are in
[the integration contract](integration.md#browser-task-handoff).

`npm run test:cross-host` is an opt-in integration test. It requires
`HERMES_CROSS_HOST_FIXTURE`, `HERMES_CROSS_HOST_SSH`,
`HERMES_CROSS_HOST_SCRIPT` and optionally `HERMES_CROSS_HOST_SUDO=1`.
The fixture URL must reach the same disposable page on both hosts. It uses
an isolated Mac profile and test bot IDs, then closes its managed tabs.

To remove the add-on, stop/disable its two services, remove its native MCP
entry from profiles and clear the Mac VPS browser setting. Preserve private
browser data/backups until recovery is no longer needed. Leave existing
Hermes, VNC and other browser services in place.
