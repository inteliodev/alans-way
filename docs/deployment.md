# Deploy Hermes- Alan's way to another Hermes instance

This is a manual setup today, with a stock Hermes gateway and an optional Mac
profile. It does not require a Hermes fork. Desktop packaging currently targets
Apple Silicon Macs; Windows, Linux desktops and Intel Mac distributions have
not been verified.

1. Install a supported stock Hermes release on the destination VPS. Create the
   primary profile and configure its model/provider through native setup.
2. Assign an existing or new Telegram bot through native messaging setup. Verify
   its numeric ID with `getMe` and keep a single active owner of its token. Follow
   [agent setup](agent-setup.md) for profile and connector identity rules.
3. Install the [agent plugin](https://github.com/inteliodev/alans-way-agents)
   on the gateway host using its documented configuration and native plugin/hook
   registration. Start with manual status/handoff verification before enabling
   optional proactive behavior. Each installation has its own credentials and
   device trust; do not distribute a user's app data or Hermes state directory.
4. Install Hermes- Alan's way on the Mac. Sign into Telegram locally and choose the bot
   visibility/order in Settings. App browser logins belong to that installation.
5. Configure a verified private SSH route from the VPS to that Mac. Launch
   `desktop/scripts/browser-mcp.cjs` on the Mac with this profile's numeric bot ID,
   using Node and the local connection file. Keep the app's HTTP endpoint on
   loopback. Set timeouts/lazy startup where supported so a sleeping Mac does not
   prevent the VPS gateway from starting.
6. If desktop viewing is wanted, run a Linux graphical session, its GUI browser,
   a VNC server and a WebSocket viewer (for example noVNC) on the VPS. Enter its
   reachable viewer URL in Workspace settings. A headless automation browser has
   no visible window; launch the GUI browser in the same display the VNC server
   shares. Snap Chromium needs a profile path allowed by its package confinement.
7. For managed cloud browser sessions, install the separate Chromium supervisor,
   tab broker and native MCP connector using the [VPS browser guide](../desktop/docs/vps-browser.md).
   Give each profile its own matching Telegram ID. The browser profile shares
   live logins; the broker restricts normal tools to assigned/granted tabs.
8. Verify a Telegram request and reply; bounded Mac and VPS tab actions; human
   **Take control**; and, if used, the backend cross-host handoff checkpoint
   with a fixture (the app exposes no handoff button; live tabs are not
   migrated). This release has one shared VPS desktop. Mac/VPS authentication
   and arbitrary live page state remain host-specific. A managed tab takeover
   blocks its browser connector; generic desktop automation is coordinated
   separately.

With Hermes, SSH and noVNC already working, deployment is mostly configuration.
A fresh headless VPS also needs desktop provisioning, display/service lifecycle
and browser setup. The agents repo's `setup.sh` bootstrap covers the Hermes
side — plugin, hook, connector config, browser host units, gateway restart,
and primary-route binding — and prints guided steps for the display/VNC stack
it can't safely automate.

Chrome extensions are a separate browser capability. The current Electron app
ships no extension installer or pinning bar. Electron supports a subset of
Chrome APIs, and 1Password desktop pairing has its own browser-signing
requirements. Check extension compatibility and license requirements before
selecting a browser extension layer. Password-vault integration needs an actual
user-authorized test, not a decorative toolbar button.
