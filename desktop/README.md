# alans-way-localapp

A free Mac desktop workspace with your Telegram bot chats on the left, real local Chromium tabs on the right, and a live VPS desktop in the corner. The dark three-pane layout follows the supplied Grok Bot reference. This is a functional first release for testing with Hermes bots.

## Use it

Open **alans-way-localapp**. The packaged bundle is `alans-way-localapp.app`; installs that still carry the older `Open Alan.app` or `Hermes Workspace.app` names keep working — update the connector paths below to match whichever bundle is installed. Sign in to Telegram with its normal QR or phone login if needed. No Telegram developer API credentials are required: the chat pane loads the official Telegram Web A and applies local styling.

- The sidebar contains verified bot conversations from your Telegram account. Drag them to sort; hover and click × to hide one. The panel button at the top of the chat collapses or restores the whole agent list, and remembers your choice. **Settings → Telegram bots** has an individual visibility switch for every discovered bot, including hidden bots. Choices save immediately and survive app restarts. Hiding a bot leaves its Telegram chat and Hermes agent intact. The + at the top opens a bot by username.
- Click the selected bot’s portrait, or **Settings → Customize bot avatars**, to choose one of the ten marble avatars or import PNG, JPEG, or WebP pictures. Click **Save avatar** to keep the choice on this Mac. Built-in eyes are already positioned; **Adjust eye positions** calibrates an imported picture. This does not change the bot’s Telegram profile photo.
- A mint/lilac orbit and eyes following the real mouse appear only while Telegram reports a live chat action from that bot. Idle portraits stay still. **Activity unavailable** means the observer cannot currently verify activity. Reduced Motion keeps the indicator static.
- The + beside browser tabs opens a Chromium tab on your Mac. ⌘L focuses its address; ⌘T opens a tab; ⌘W closes a local tab. Drag the divider to resize the chat pane. The speech button beside the address bar drops the current page's title and link into the selected bot's Telegram draft — the agent can then inspect that tab with its browser tools.
- The puzzle button beside the address bar opens **Extensions → Browse Chrome Web Store**. Install an extension from its store page, review its requested access, and pin its icon beside the address bar. Enable, unpin or remove extensions in the manager, also available through Settings. Unpacked folders remain supported. Installations and enable/pin choices survive app restarts; store extensions receive automatic update checks.
- The extension host adds browser actions, dynamic popups, tabs/windows APIs and a native messaging bridge to Electron. Compatibility remains extension-dependent. For 1Password, sign in inside the extension. Mac-app unlock and Touch ID require a properly signed browser and approval in 1Password; this local build does not promise that integration. See [extension compatibility research](docs/extensions-research.md).
- Links sent in a bot's chat — by you or the bot — open automatically as a local tab assigned to that bot, so both of you see the same page. Your own sends focus the new tab; bot sends open in the background. Disable in Settings. If the Mac is unreachable the bot opens a fresh copy of the page on the VPS desktop instead — the Mac tab itself is not moved or migrated.
- **Agent tabs** shows the selected bot's local Mac tabs; switch to **All tabs** to inspect all local tabs. Switching bots remembers each bot's selected local tab during the session. VPS Chrome tabs appear only inside the desktop picture, where Chrome supplies its own tab controls.
- Paste an existing noVNC viewer URL into Settings. Keep Tailscale connected for a private VPS. The small desktop floats over the workspace in Watch mode — drag its title strip anywhere, use ⤢ to expand it full size or × to hide it, and click the corner chip to bring it back. The workspace header button also expands the virtual desktop to fill the browser area; click it again to return to your previous local tab. The tab row contains local browser tabs only. Agent work on the VPS shows the driving bot's named, colored cursor and page tint inside the streamed picture.
- **Take control** enables mouse, drag, scroll and keyboard input to the VPS desktop. **Stop control** returns to Watch. The viewer is independent of the browser tab bar and does not pause desktop or browser agents. The **Paste** button sends the Mac clipboard only when explicitly clicked in control mode.
- Local Mac tabs have an assigned bot ID. **Take over** blocks new local browser actions from the connector; **Give to agent** returns control. The overseer bot sees every tab; other bots see only their own. A bot can take control of its own tab at any time through the connector's control endpoint, and a bot explicitly shared on a tab (or claiming a shared tab) can take it over too — even while it is under human control; the accent tint makes the handoff visible. Native VPS agent browser tools remain separately configurable using the [VPS setup guide](docs/vps-browser.md).

Local tabs share this app's browser profile, so cookies and login changes are shared between tabs and bots running in the app. This is separate from Chrome/Safari profiles and from the VPS browser. Your Telegram session is stored in a separate profile.

## Give Hermes the local browser tools

Node 20+ is needed for the MCP connector; the desktop app itself includes its runtime. The connector is included in the installed app at:

```text
/Applications/alans-way-localapp.app/Contents/Resources/app/scripts/browser-mcp.cjs
```

For a Hermes process running on the Mac, merge this server entry into that profile's existing `mcp_servers` configuration. Replace the Node path and bot ID. The ⇄ dialog shows the ID of the assigned bot.

```yaml
mcp_servers:
  workspace_browser:
    command: /absolute/path/to/node
    args:
      - /Applications/alans-way-localapp.app/Contents/Resources/app/scripts/browser-mcp.cjs
      - --bot-id
      - YOUR_BOT_ID
```

For a Hermes process on the VPS, run the same command on the Mac through its already authorized SSH connection:

```yaml
mcp_servers:
  workspace_browser:
    command: ssh
    args:
      - -T
      - -o
      - BatchMode=yes
      - YOUR_MAC_SSH_HOST
      - "'/absolute/path/to/node' '/Applications/alans-way-localapp.app/Contents/Resources/app/scripts/browser-mcp.cjs' --bot-id YOUR_BOT_ID"
```

Use a different `--bot-id` for each bot. Keep existing Hermes settings and server entries. Restart or reload MCP through the workflow supported by your installed Hermes version. This project does not modify Hermes source or apply changes to running bot profiles.

The six tools are `workspace_browser_status`, `workspace_browser_tabs`, `workspace_browser_open`, `workspace_browser_snapshot`, `workspace_browser_screenshot`, and `workspace_browser_action`. Actions need the current tab epoch. Use fresh snapshot refs after each action. Bot tabs open in the background by default; pass `background: false` only to explicitly select a Mac tab. Open defaults to `host: mac`; choose `host: vps` explicitly for VPS work. The Mac connector requires the Mac awake and app running. A separate native VPS connector can continue cloud browser work while the Mac is offline. There is no silent fallback between hosts.

`workspace_browser_action` is the bot’s separate input command. `move` and `click` accept a snapshot ref or viewport `x,y`; `type` replaces text at a fresh ref; `press` sends keys to that tab; `scroll` uses `x,y` as deltas. A pointer labeled with the driving bot's name glides across the page during dispatched input — every bot owns a distinct color derived from its ID — the target element flashes blue and the page frame gains a teal tint while a bot holds control. These commands use Chromium’s tab-specific input protocol and never move the system mouse, paste into another app, or activate the bot’s window. Agent keyboard shortcuts cannot trigger workspace shortcuts. **Take over** revokes queued input; an action already delivered to Chromium cannot be recalled.

## What the activity indicator verifies

The observer passively reads Telegram Web A’s API Worker `updateChatTypingStatus` events, derived from Telegram’s real [typing/chat-action updates](https://core.telegram.org/constructor/updateUserTyping). The chat and actor must both identify a discovered private bot. New messages, outgoing prompts, unread counts, and cached previews never start the animation. A fresh action lasts at most six seconds, and explicit cancellation stops it immediately. Availability heartbeats keep the observer connection known; they never extend an action. Account changes, disconnection, and a missing adapter clear activity.

This verifies Telegram-reported activity, not backend computation: a bot must emit chat actions while it works. Idle means there is no current Telegram activity signal, not proof its process has stopped. The adapter follows the [Web A worker envelope](https://github.com/Ajaxy/telegram-tt/blob/master/src/api/gramjs/worker/connector.ts) and [typing update mapping](https://github.com/Ajaxy/telegram-tt/blob/master/src/api/gramjs/updates/mtpUpdateHandler.ts); upstream changes may require an adapter update. No Hermes source patch or bot token is needed.

The chat also shows a soft green glow orbiting the text-box border while the bot in the open chat is live. It tracks Telegram's own typing indicator element, so it starts and stops in lockstep with the native typing animation — no separate timers. Local workspace work lights it too, since dispatching input or navigating an agent tab emits no chat action. It uses the same avatar-glow green as the agent cursor, page tint, and control state, so agent presence reads as one color everywhere.

The connector reads the current private connection file on the Mac, so no token needs to be pasted into Hermes configuration. The HTTP service listens only on `127.0.0.1:9464`, rejects browser-origin requests, and authenticates its native connector. Bot IDs guard against accidental crossover within this trusted connector; they are not independent authentication credentials.

## Build and test

```sh
npm ci
npm run check
npm run test:desktop
npm run test:agent-input
npm start
npm run package:mac
```

The package command builds an Apple Silicon Mac app in `dist/Intelio-darwin-arm64`. It includes a custom icon and the Node MCP connector. This is a local development build; signed/notarized public distribution is a later release step. Building and running locally does not require a paid developer account.

With the app open, `node test/browser-smoke.cjs` exercises the real MCP protocol against its own local test page. It checks typing, clicking, screenshots, popups, shared cookies, bot ownership, and stale epochs. It asks you to click Take over and Give to agent to verify the human control boundary. It sends no Telegram messages and operates no third-party forms.

`node test/background-browser.cjs` verifies replacement typing, clicks and screenshots in a background tab without selecting it. Agent input uses Chromium's per-tab input protocol, so it can operate while the app is in the background. Background tabs render inside a separate hidden, nonfocusable window. Screenshots capture their existing surfaces without reparenting them into the human’s window.

`npm run test:desktop` launches the real app with an isolated temporary profile, tests avatar selection/import/removal/persistence, and runs the real MCP background-browser test while asserting the human tab, draft, and focus remain unchanged. `npm run test:agent-input` exercises real trusted Chromium pointer and keyboard events in separate human/agent views. Neither sends Telegram messages or submits third-party forms. Unit tests cover activity expiry, cancellation, account isolation, avatar calibration, ownership, and mid-action takeover.

`npm run test:extensions` exercises a harmless MV3 extension in a temporary profile: module worker APIs, selected-tab context, content scripts, sandboxed popups, human takeover, enable/pin persistence, restart and removal. `npm run test:web-store` is a network integration test of the actual public 1Password Web Store install, rendered extension screen, restart and removal. It uses a disposable profile and no account or vault.

App data lives in `~/Library/Application Support/Hermes Workspace/`. The product renames to Open Alan and then alans-way-localapp both preserve this existing directory; the bundle ID is now `app.alans-way.localapp`. That directory holds private sessions, bot order/hiding preferences, the desktop URL, and a startup-rotated connector token. It is outside the source tree. The app restores up to twelve tab URLs after restart; live page execution state is not restored.

## Companion integration

This app lives in `desktop/` in the hermes-companion repository. The
[agents repo](https://github.com/inteliodev/alans-way-agents) owns the VPS
side — `setup.sh` there is a one-command bootstrap that installs the plugin,
wires the browser connector, restarts the gateway, and binds the primary
route (including the path for a Hermes that has never configured Telegram).
Settings → Agent setup shows a live checklist and copies a pre-filled
bootstrap command or agent prompt for your setup.

Use `/proactivity status`, `/proactivity pause`, `/proactivity resume`, or
`/proactivity review` in the primary's Telegram chat here. These commands reach the real
plugin; the UI does not maintain a second proactivity state. Configure the
browser MCP entry above on the same primary to let it use the local tabs.
[The integration contract](docs/integration.md) describes the browser interface.

Control handoff of the **same live Mac tab** retains its full page state on the Mac. Backend cross-host checkpoint/restore plumbing remains for later Companion integration, but the app offers no VPS tab creation or cross-host handoff button. Sign-ins are shared live within each host, separately on Mac and VPS. Cross-host login propagation, automatic task resumption and separate per-bot desktop streams remain additional work.

For a small fleet of stock Hermes profiles, use the [agent setup guide](../docs/agent-setup.md). It covers workspace routing, recoverable retirement of legacy profiles, and verifying real replies after Hermes updates.

## Implementation and licenses

- Electron `WebContentsView` renders actual Chromium pages; the app does not embed ordinary websites in restricted iframes. [Electron documentation](https://www.electronjs.org/docs/latest/api/web-contents-view).
- The official [Telegram Web A](https://web.telegram.org/a/) supplies messaging. The wrapper styles its DOM and reads its local IndexedDB cache for positively identified bots; it does not use a bot token to impersonate a user. Cache/schema changes upstream can require compatibility updates. [Telegram Web A source](https://github.com/Ajaxy/telegram-tt).
- [noVNC](https://github.com/novnc/noVNC) renders the existing remote desktop, using its own MPL-2.0 license.
- The [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) implements the stdio connector.

The desktop distribution is **GPL-3.0-or-later**, using the free GPL option of `electron-chrome-extensions`. The separate Python Hermes add-on remains MIT. See [LICENSE](LICENSE) and [dependency notices and source requirements](NOTICE.md). Dependency notices are included with the packaged app. This project is independent of Grok Bot, Telegram, and Nous Research.
