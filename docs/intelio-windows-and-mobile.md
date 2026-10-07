# Intelio on Windows and on a phone

The VPS Hermes (`intelio-vps.tail9c1007.ts.net`, port 8642, profile `intelio`) stays the only brain. The Windows app and the phone are thin clients. They never ship an API key, and they never open a public port.

The phone is a small installable web app plus a session proxy, not a second native codebase. It is served on the tailnet. Sign-in is the phone's Tailscale identity. The proxy reads the profile key from the VPS env file and keeps it in memory. The page JavaScript never contains it, and nobody types it. An Expo app would still need the same tailnet proxy, plus a store or a sideload, so the web app is the client that matches this setup.

## Windows installer

From `desktop/`:

```sh
npm ci
npm run package:win
```

`npm run package:win` rebuilds the preload, writes `build/icon.ico` from the harness brand mark, and runs electron-builder NSIS for x64. The result is `desktop/dist/Intelio-Setup-<version>.exe`.

The installer is one-click and per-user (no admin prompt): Start menu shortcut and a desktop shortcut, both named Intelio. It packages the desktop app as it is, including the Intelio profile, brand, and Remote Hermes client under `resources/intelio-repo`. It does not include a copy of upstream Hermes. Signing is off (`signAndEditExecutable: false`).

### First launch

On Windows, when there is no preferences file yet, the main window enters Remote Hermes (it does not fall back to the Telegram sign-in screen):

- host `intelio-vps.tail9c1007.ts.net`
- port `8642`
- profile `intelio`

Do not type or paste profile keys. Before launch, place `remote-hermes-key.import` in the app data folder (`Hermes Workspace`, under `%APPDATA%` on Windows and `~/Library/Application Support` on macOS). Each line is `<profile>=<key>`. A legacy `API_SERVER_KEY=...` line, or a single raw key, is the intelio key. A `vnc=` line is the VPS desktop password. It is encrypted with the profile keys and filled in when the desktop pane asks, not typed and not put in the viewer URL. If that line is missing, the password prompt stays. On startup Intelio encrypts every usable line with Electron `safeStorage` (Windows DPAPI, macOS Keychain, or libsecret) into `remote-hermes-keys.json` (mode 600), the same store Settings uses, overwrites the import file with zeros, and deletes it. The window then shows **Connected to VPS Hermes**. If the operating system cannot encrypt, the import file is left in place and nothing is stored. Keys stay in the main process. After a rotation, drop a fresh import file before the next launch so the stored keys are replaced. With Remote Hermes on, the main window (orbs, agent list, chat) talks to the VPS. The separate Remote Hermes window is still available, and it is not the primary chat. Local Telegram mode remains the macOS default until Remote Hermes is enabled. Loading the Intelio profile still wants Python 3 and PyYAML on the machine. Chatting with the VPS does not.

The first window checks Tailscale (`tailscale version`, then `tailscale status --json`). If it is missing, the dialog offers **Install Tailscale**, which opens `https://tailscale.com/download/windows`. If it is installed but signed out, the dialog says to connect. Settings keeps the same status and the install button whenever Tailscale is not connected. Nothing in the app is reachable from the public internet; the host check still refuses a non-tailnet address before any request.

### SmartScreen

The executable is unsigned. Windows shows Microsoft Defender SmartScreen (“Windows protected your PC”). Choose **More info**, then **Run anyway**. That step goes away only after the installer is signed with a certificate Hayden trusts. Do not host the file on a public download page. The GitHub Release created by the workflow below is a **draft** on this private repository.

### GitHub Actions

`.github/workflows/windows-installer.yml` runs on `windows-latest` for **Run workflow** (`workflow_dispatch`), for tags `v*`, and for pushes to `cursor/intelio-harness-layer-8db4`. It uploads `Intelio-Setup` as a workflow artifact. A tag push names the draft release after that tag. A branch push attaches `Intelio-Setup-<version>.exe` to the draft release `v0.3.11-intelio-windows`, creating it or replacing the asset if that draft already exists. After the installer is built, the workflow runs `Intelio.exe --smoke-test`, then launches that packaged app against a fake Hermes behind a fake Access login and checks that the sign-in screen appears, that Auto falls back to Cloud when the Tailscale host is unreachable, that bootstrap fills the profile keys, and that the main window then shows four agents with that agent's threads underneath, and keeps the remote Hermes version (`hermes-agent 0.21.5 · Cloud` from `/health`) with no “unavailable” or error text. The VPS host and version stay in Settings, not the sidebar. It checks that those threads are listed under the agents, and that the visible window text does not contain “Alan”. Screenshots are the `intelio-e2e-main-window` workflow artifact. The same workflow also builds an unsigned Apple Silicon zip, `Intelio-<version>-mac-arm64.zip`, and attaches it to that draft. A fresh macOS launch uses the four VPS harness profiles. It does not publish the release.

Dispatch it from the Actions tab on this branch: `windows-installer` → Run workflow. The run URL looks like `https://github.com/inteliodev/alans-way/actions/workflows/windows-installer.yml`.

## Phone

`mobile/pwa/` is a static page (`public/`) and `server.cjs` (Node’s standard library only, plus an optional local speech worker).

- Bind address is required (`INTELIO_PWA_BIND`). It must pass the same tailnet-or-loopback check as the desktop client. A public name or a wildcard bind exits before listen.
- Default port `8643`. Hermes is reached at `http://$(tailscale ip -4):8642` with the `/p/intelio` prefix. It does not listen on `127.0.0.1`. An older env file that still says loopback is rewritten to that tailnet address on upgrade.
- There is no key field. Each request is authorized by the caller's Tailscale login: `tailscale whois --json <remote ip>`, or the local tailscaled API on `/localapi/v0/whois` if the CLI returns nothing. The login must be in `INTELIO_PWA_ALLOWED_LOGINS` (comma or newline separated, compared case-insensitively). An empty allowlist is refused before whois. A non-tailnet address and an unknown login get HTTP 401. Denials are logged to stderr (at most once per 30 seconds) as the address, the reason, and the login. The key is never logged.
- The allowlist is not hardcoded. On a real install, if `INTELIO_PWA_ALLOWED_LOGINS` is unset in the environment and in the existing env file, the script reads `tailscale status --json` and keeps `Self.UserID` → `User[id].LoginName`.
- The profile key is read on the VPS from `~/.hermes/profiles/<profile>/.env` (or `INTELIO_PWA_KEY_FILE`). The file must be a regular file, mode `600`, not a symlink. `chmod 600 ~/.hermes/profiles/intelio/.env` before the first request. The process caches that key in memory and drops it on restart, which is how a rotated key is picked up. It is never written into `pwa.env`, a cookie, or the page.
- A successful check sets an HttpOnly `SameSite=Strict` cookie for 12 hours. The cookie names the Tailscale login, not the key. `POST /session` is HTTP 405. Cross-origin requests are refused.
- The page calls same-origin `/api/home`, messages, and `/api/sessions/:id/chat`. The proxy adds the bearer and streams SSE. Voice turns use that same chat route, so they show up in the Telegram and desktop session lists.
- Icons are the harness mark scaled to 192 and 512. `manifest.webmanifest` and `sw.js` are what the browser uses for Add to Home Screen. iPhone: Share → Add to Home Screen. Android: menu → Install app. A service worker needs a secure context, so install is reliable on `https://` (see below) and on localhost. Plain HTTP on the tailnet still loads the chat. The microphone does not: iOS Safari requires the tailscale certificate and a tap. Leaving the app or locking the phone pauses the call; iOS will not keep the mic running in the background.

### Voice

Pinned Hermes (`5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662`) reports `audio_api: false`. The phone still asks `/v1/capabilities` at runtime and will proxy `/v1/audio/transcriptions` and `/v1/audio/speech` if a later server advertises audio. Until then, speech stays on the VPS, inside this process, on the tailnet:

- Speech to text: `faster-whisper==1.2.1`, model `base`, compute `int8`, 2 CPU threads.
- Speech from text: `piper-tts==1.3.0` with `en_US-lessac-medium`.
- Decoder pin: `av==18.1.0`. PyAV 19 removed `metadata_errors`, which faster-whisper 1.2.1 still passes to `av.open`.

Kokoro and any cloud voice (including Edge) are not used. Edge would send audio off the tailnet. The on-phone Web Speech API is the fallback when the VPS engines are down. On iOS that fallback can send audio to Apple; the VPS engines do not.

Push-to-talk sits on the composer mic. Call mode is hands-free: the page watches mic level, stops speech when you talk, and reads each sentence as it arrives. The engine choice is in the phone settings sheet (`auto`, `hermes`, `vps`, `web`).

Measured on a 16 GiB cloud VM with the weights already cached and `INTELIO_VOICE_THREADS=2` (about 4.3 GiB RAM available at the start). This is not the 2 vCPU VPS, so speech-to-text there will be slower. One sentence, 2.635 s of 22050 Hz mono audio, 116268 bytes:

| Step | Time | Real-time factor |
|---|---|---|
| Whisper load | 0.811 s | |
| Piper load | 0.867 s | |
| Piper speak | 0.082 s | 0.031 |
| Whisper hear | 0.547 s | 0.208 |

The transcript matched the spoken sentence. Process max RSS was 503796 KB (about 492 MiB) with both models loaded. Budget that on the 8 GB VPS next to Hermes.

### Put it on the VPS

Do this on the VPS, over Tailscale, as the desktop user. This repository does not deploy it for you. The unit is `intelio-pwa.service`.

```sh
cd "$(systemctl --user show -p WorkingDirectory --value intelio-pwa.service)"
git pull
bash mobile/deploy/install-on-vps.sh --with-voice
```

A first install, from a checkout of this repo, is the same script after you set the bind. Use the MagicDNS name or `tailscale ip -4`.

```sh
export INTELIO_PWA_BIND=intelio-vps.tail9c1007.ts.net
export INTELIO_PWA_PORT=8643
# Recommended so the microphone and Add to Home Screen get a trusted tailnet certificate:
#   cd ~/.config/intelio && tailscale cert intelio-vps.tail9c1007.ts.net
#   export INTELIO_PWA_CERT=$HOME/.config/intelio/intelio-vps.tail9c1007.ts.net.crt
#   export INTELIO_PWA_KEY=$HOME/.config/intelio/intelio-vps.tail9c1007.ts.net.key
#   chmod 600 "$INTELIO_PWA_CERT" "$INTELIO_PWA_KEY"
# INTELIO_PWA_KEY is the TLS key path. It is not the Hermes API key.
bash mobile/deploy/install-on-vps.sh --with-voice
```

Voice packages install before `systemctl --user restart`. A failed voice install leaves the running phone client alone. The script keeps the existing bind, certificate path, and TLS key path. It writes `~/.config/intelio/pwa.env` (mode 600, no API key), installs the systemd **user** unit `intelio-pwa.service`, restarts it if it is already enabled, and runs:

```sh
sudo ufw allow in on tailscale0 to any port 8643 proto tcp comment 'Intelio phone client, tailnet only'
```

That rule is interface-scoped. Do not add the port on the public interface, and leave the Hostinger firewall on port 22 only. If the user service should keep running after logout: `sudo loginctl enable-linger "$USER"`.

`bash mobile/deploy/install-on-vps.sh --dry-run` prints the bind, the allowlist source, the voice pins, and the ufw line, and changes nothing. A public bind fails the dry run.

This installer restarts `intelio-pwa.service` only. It does not restart `hermes-gateway`. A new agent’s `/p/<profile>` route appears after the phone asks, and you confirm, `systemctl --user restart hermes-gateway`. That restart drops Telegram for a moment.

## Twilio phone bridge

Caddy on the VPS is the public front. `https://2-24-110-12.sslip.io/twilio/*` proxies to `127.0.0.1:8650/twilio/*` with the path preserved, WebSocket upgrades, and a 64KB body limit. The bridge process listens on loopback only. It does not open a firewall port.

`mobile/phone/bridge.cjs` checks `X-Twilio-Signature` against `PHONE_PUBLIC_BASE` plus the path (`https://2-24-110-12.sslip.io/twilio/sms`, `/voice`, and `wss://2-24-110-12.sslip.io/twilio/relay`). A request signed for any other host is rejected. SMS for a number in `PHONE_NUMBER_PROFILES` is forwarded, raw body and signature unchanged, to that profile's `/webhooks/twilio`. Voice answers only `PHONE_ALLOWED_CALLERS` (default `+19188991650`) with ConversationRelay; every other caller gets `<Reject reason="rejected"/>`. The relay uses a one-time nonce from that answer, opens a Hermes session titled `Phone call`, and streams a short spoken reply. Logs mask numbers and never include the request body or a profile key.

`bash mobile/deploy/install-phone-bridge.sh` installs the user service `intelio-phone-bridge.service` and reads `~/.config/intelio-phone/env` (mode 600). A later run leaves that file in place. `--dry-run` prints the loopback bind and the Caddy paths and writes nothing. The installer does not edit Caddy, does not open UFW, and does not restart `hermes-gateway`. Set `SMS_WEBHOOK_URL=https://2-24-110-12.sslip.io/twilio/sms` on each profile that should receive texts, then restart the gateway yourself when you want Hermes to check that same signature.

```
PHONE_PUBLIC_BASE=https://2-24-110-12.sslip.io/twilio
PHONE_ALLOWED_CALLERS=+19188991650
PHONE_NUMBER_PROFILES=+1918...=intelio,+1...=prc
```

Twilio's voice webhook is `https://2-24-110-12.sslip.io/twilio/voice` and the SMS webhook is `https://2-24-110-12.sslip.io/twilio/sms`.

Open `http://intelio-vps.tail9c1007.ts.net:8643` (or `https://` after `tailscale cert`) from a phone that is on the tailnet as an allowed login. The page opens signed in. The gear in the top bar and the Settings row in the drawer open voice mode, the Tailscale sign-in, appearance, and the version. Appearance follows the phone until you tap Light or Dark; that choice is stored in `localStorage` as `intelio-theme` and updates the status bar. Each agent is a dotted thought-orb from `inteliodev/thinking-orbs` at `de85557ca220332586d070d8788c0e1d6e877a0d` (MIT, Jakub Antalik). Intelio is the connecting constellation, PRC is solving, Alignment is the searching globe, HHP is weaving, and Kid A is composing. Any other profile id picks one of the remaining types (working, listening, breathing, shaping) from a hash, and keeps a soft halo in its hue. Lists hold a still frame of that signature. The home hero, the chat, and the call play the live activity when the agent is working, searching, listening, or speaking, and otherwise drift gently in the signature type. The home-screen icon is a still Intelio constellation on the site’s dark background. Home and the drawer list the Hermes profiles on this machine. Chats and calls for a profile go to the shared gateway at `/p/<profile>/`. New agent asks for a lowercase name, an optional one-line description, and an optional profile to copy skills from. It does not copy credentials. The bottom bar is Chat and Sessions. Library appears when `GET /v1/skills` succeeds, and Goals when `GET /api/jobs` succeeds. There is no Ideas tab. Telegram, app, and CLI sessions are the same list the desktop uses. Screenshot layouts with several profiles are sample data, labeled SAMPLE DATA, and only run when the bind is loopback.

## Bops-mode (0.3.11)

`fill_saved_login` takes the profile from the gateway’s per-message Hermes home (`set_hermes_home_override`, or `hermes_cli.profiles.current_profile_name(None)`). It does not read `INTELIO_HERMES_PROFILE` or `HERMES_PROFILE`, and it does not fall back to `intelio`. `default`, `custom`, `unknown`, or any error resolving the profile returns `Unknown profile.` and does not open another profile’s `.env` or vault.

Each profile’s browser is `~/.hermes/profiles/<profile>/bot-desktop/cdp.url`. That file is one line, a loopback origin, for example `http://127.0.0.1:9224`. Write one per profile, with that profile’s own debugging port:

```sh
mkdir -p ~/.hermes/profiles/prc/bot-desktop
printf '%s\n' 'http://127.0.0.1:9224' > ~/.hermes/profiles/prc/bot-desktop/cdp.url
chmod 600 ~/.hermes/profiles/prc/bot-desktop/cdp.url
```

Repeat for `intelio`, `alignment`, `hhp`, and `kid-a`, each with its own port. `INTELIO_CDP_URL` does not apply. A profile with no `cdp.url` is not typed into. To opt that one profile into the shared agent browser on `http://127.0.0.1:9223`, create an empty `~/.hermes/profiles/<profile>/bot-desktop/allow-shared-browser`. Without that file the filler refuses.

The filler types only into a tab whose host is the saved domain or a subdomain of it. If none match, it types nothing. It reads the tab URL again before each field, and stops if the page has navigated away. Submit (`POST /api/vault/login`) and `POST /api/vault/fill` use that same check.

Every `/api/vault/` route checks the profile key before Tailscale identity. A request that sends a bearer token must match that profile’s key exactly. A wrong key, including another profile’s key, is 401 and does not fall through. A request from this VPS (loopback, one of its own addresses, or its own tailnet node) must send that key. Tailscale identity is only the fallback for a remote allowlisted device, such as Hayden’s phone or laptop. Denials log the profile and the reason. They do not log the key.

The maximize watcher clears `XAUTHORITY` before each display, so a display without `bot-desktop/Xauthority` does not keep the previous display’s file. `No Chromium window` is logged when that state starts, not on every 2 second pass.

The toolset name is `intelio`. Each profile has its own `~/.hermes/profiles/<profile>/config.yaml`. `platform_toolsets` is the allowlist the model sees. `known_plugin_toolsets` only records which plugin toolsets `hermes tools` has already shown; a toolset listed there and missing from `platform_toolsets` stays off. Add `intelio` under every platform key that profile already has. Do not put it only in `known_plugin_toolsets`.

```yaml
platform_toolsets:
  cli:
    - hermes-cli
    - intelio
  telegram:
    - hermes-telegram
    - intelio
known_plugin_toolsets:
  cli:
    - intelio
  telegram:
    - intelio
```

Keep the toolsets already in that file and add `intelio` to each of them. If the profile serves more platforms than `cli` and `telegram`, add `intelio` to those keys too. Restart `hermes-gateway` after the config change.

`scripts/intelio-bot-desktop-maximize.service` sets `INTELIO_HARNESS_DIR` to `%h/intelio/alans-way-pwa`, the VPS checkout that contains `scripts/bot-desktop-maximize.sh`. Change that variable if the script lives somewhere else.

Hermes writes `bot-desktop/display` as `20` or `21` with no colon. The maximize script adds `:` before it matches that file to an X socket, so `XAUTHORITY` is the profile’s `bot-desktop/Xauthority`. `wmctrl` is used only when `wmctrl -m` sees a window manager. Display `:99` has none, and then the script uses xdotool. `no Chromium window found` from xdotool is the same missing state as an empty wmctrl list: `No Chromium window` is logged once when that state starts.

The plugin does not call `http://127.0.0.1:8643`. The phone client listens on `https://<tailnet-host>:8643` when `~/.config/intelio/pwa.env` sets `INTELIO_PWA_CERT` and `INTELIO_PWA_KEY` (otherwise `http` on `INTELIO_PWA_BIND`). `fill_saved_login` reads that file. `INTELIO_FILLER_URL` overrides it. Pin it with a gateway drop-in so the user service does not depend on the file being readable:

```sh
mkdir -p ~/.config/systemd/user/hermes-gateway.service.d
cp scripts/intelio-filler.conf ~/.config/systemd/user/hermes-gateway.service.d/intelio-filler.conf
```

Edit the copied file and set the host from `INTELIO_PWA_BIND`:

```
[Service]
Environment=INTELIO_FILLER_URL=https://intelio-vps.tail9c1007.ts.net:8643
```

Then `systemctl --user daemon-reload` and `systemctl --user restart hermes-gateway`. That restart is the one that loads the plugin. Restart `intelio-pwa.service` when the filler code changes. It does not register the tool.

Optional per-profile browsers are `scripts/bot-desktop-chromium.sh` and `scripts/intelio-bot-desktop-chromium.service`. Nothing enables them. They launch Chromium for `prc` (`127.0.0.1:9224`), `alignment` (`9225`), and `hhp` (`9226`), each on the display in `bot-desktop/display`, with its own `--user-data-dir` at `bot-desktop/chromium`, and `--remote-debugging-address=127.0.0.1`. They write `bot-desktop/cdp.url` mode 600. Intelio stays on the shared `127.0.0.1:9223` browser. Debugging stays on loopback, the same rule as that browser. The script does not start the VPS broker and does not change its navigation policy: payment hosts and `/checkout`, `/payment`, and `/billing` stay ask-first in `desktop/src/intelio/safety.cjs`. To run them later, copy the unit into `~/.config/systemd/user/` and enable it yourself. This deploy does not enable it.

## Bops-mode (0.3.10)

Remote mode Settings does not show the local Intelio profile, the local Hermes command, or a local pin check. That block is the VPS Hermes version from `/health` (`hermes-agent 0.21.5 · Cloud` when that is what the gateway reports). Windows labels say This PC: the screen pane, the SSH address, and the browser connector. macOS keeps Mac. Light theme paints the 2–4 screen grid with the light surface and a `#d5d5dc` border.

Submit on a Secure Sign-in card calls the VPS filler. The filler attaches to that profile’s loopback CDP file, `~/.hermes/profiles/<profile>/bot-desktop/cdp.url`, and types into the selectors on the card. Save login is optional. A password or one-time code is not written into the task, the transcript, or the tool result. See 0.3.11 for the per-profile file, the shared-browser opt-in, and the host check.

`fill_saved_login(site)` is the Hermes plugin in `plugins/intelio-vault/` (not a Hermes core edit). It POSTs the site to the phone client’s `/api/vault/fill`. On this VPS that is `https://<tailnet-host>:8643` from `~/.config/intelio/pwa.env`, or `INTELIO_FILLER_URL` in the `hermes-gateway` drop-in. The filler reads that profile’s vault and types the secret. The tool result is domain and username only.

Install, on the VPS as the desktop user:

```sh
mkdir -p ~/.hermes/plugins
rm -rf ~/.hermes/plugins/intelio-vault
cp -a plugins/intelio-vault ~/.hermes/plugins/intelio-vault
mkdir -p ~/.config/systemd/user/hermes-gateway.service.d
cp scripts/intelio-filler.conf ~/.config/systemd/user/hermes-gateway.service.d/intelio-filler.conf
systemctl --user daemon-reload
systemctl --user restart hermes-gateway
systemctl --user restart intelio-pwa.service
hermes plugins list
```

The copied drop-in is commented. Uncomment `Environment=INTELIO_FILLER_URL=` and set the host from `INTELIO_PWA_BIND` when you want to pin it (`https://intelio-vps.tail9c1007.ts.net:8643` on this VPS, because `pwa.env` has both a cert and a key). Leaving it commented lets the plugin read `~/.config/intelio/pwa.env`.

A gateway restart is required. Hermes loads plugins when the gateway process starts, so `fill_saved_login` is absent until `hermes-gateway` restarts. Restarting the phone service picks up the filler. It does not register the tool.

Remote mode on the laptop posts Submit, the saved-login list, and delete to the VPS at `http://<tailnet-host>:8643` with the profile API key. It does not write `~/.hermes` on the laptop. Set `INTELIO_VAULT_ORIGIN` only for `app.intelio-ai.com` or another tailnet URL.

Vault profiles are the directories under `~/.hermes/profiles` plus `hermes profile list`. The key is read from `$CREDENTIALS_DIRECTORY/vault.key.<profile>` when systemd loaded one, and otherwise from `vault.key` (mode 0600). To move a key into systemd-creds:

```sh
systemd-creds encrypt --name=vault.key.hhp --uid="$(id -u)" \
  ~/.hermes/profiles/hhp/vault.key /etc/credstore.encrypted/intelio-vault-hhp
```

User unit drop-in:

```
[Service]
LoadCredentialEncrypted=vault.key.hhp:/etc/credstore.encrypted/intelio-vault-hhp
```

Bot Desktop maximize reads `~/.hermes/profiles/<profile>/bot-desktop/display` (`20` or `:20`) and sets `XAUTHORITY` to that profile’s `bot-desktop/Xauthority`. It walks only X sockets that exist, uses wmctrl when `wmctrl -m` sees a window manager, and uses xdotool when it does not (`:99`). No Chromium window, including xdotool’s `no Chromium window found`, is logged once when that state starts. It does not print success when xdotool fails. The watcher is a user unit:

```sh
mkdir -p ~/.config/systemd/user
cp scripts/intelio-bot-desktop-maximize.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now intelio-bot-desktop-maximize.service
```

The unit’s `INTELIO_HARNESS_DIR` defaults to `~/intelio/alans-way-pwa`, which is the checkout that contains `scripts/bot-desktop-maximize.sh`. This unit does not restart `hermes-gateway`.

alans-way-agents `setup.sh` is not writable from this checkout. Add these two lines to the default `browserArgs` after `--start-maximized`:

```
"--window-position=0,0",
"--window-size=1920,1080",
```

## Bops-mode (0.3.9)

Parallel tasks are split in the Intelio app, not by a Hermes tool. A message with several lines, or two long parts joined by “and”, becomes one status pill per part. The app opens a Hermes session per part and sends them together. Stop all marks the pills stopped and drops results that arrive later. The focused pill selects that task’s caption on the Bot Desktop preview (`/api/display/ws`, one screen per profile) and draws that profile’s color on the preview chrome. The badge reads “Intelio is browsing” (or the selected agent’s name).

A login wall shows an in-chat Secure Sign-in card: site mark, domain, username, masked password, masked one-time code, Save login, Submit, and Do it on screen. Submit sends those values write-only over the authenticated harness channel to the filler. They are not copied into the task, the model context, transcripts, or logs. Save login stores them in that profile’s encrypted vault (`~/.hermes/profiles/<profile>/vault`, AES-256-GCM, key in `vault.key` mode 0600, additional data is the profile id). PRC cannot read HHP. Settings lists site and username only, and can delete a row. `fill_saved_login(site)` returns domain and username. The secret stays in the filler payload.

A payment, or any other pause, sets the task to paused and shows one line: “Payment paused. Intelio does not submit payments.” or “Paused.” There is no approval card.

When Remote Hermes is on, the agent computer fills the right panel on launch. The screen control (1–4) splits that panel. The active screen keeps a yellow frame. Call starts an in-app microphone session and a duration pill. Ending it leaves “26s - Call ended”.

Handoff is a stub. Hermes has no peer-delegation tool in this build. “Hand this to PRC” (also Alignment, HHP, Intelio) opens a session on that profile and sends a redacted note. The other tasks stay on the current profile. Profile keys are not copied.

Bot Desktop displays (:20 and up, Xfce) maximize Chromium with:

```sh
bash scripts/bot-desktop-maximize.sh :20
bash scripts/bot-desktop-maximize.sh --all
```

Legacy display :99 has no window manager. Add `--window-position=0,0 --window-size=1920,1080` to the `browserArgs` default in alans-way-agents `setup.sh` (that repo is not this checkout).

A dedicated email address and a Twilio in-app waveform are follow-ups.

### Phone at app.intelio-ai.com

The phone does not need Tailscale. The existing Cloudflare tunnel `intelio-os` sends `app.intelio-ai.com` to a loopback HTTP listener. Cloudflare terminates TLS. Access app `Intelio OS` (team `muddy-scene-4e1c.cloudflareaccess.com`) covers both `os.intelio-ai.com` and `app.intelio-ai.com` and signs Hayden in with email OTP. Put this ingress rule on that tunnel. No path prefix. Do not open UFW for this port.

```yaml
- hostname: app.intelio-ai.com
  service: http://127.0.0.1:8644
```

`INTELIO_PWA_ACCESS=1` keeps the existing tailnet HTTPS listener and adds plain HTTP on `127.0.0.1:8644` for cloudflared. Audience, team, and the email allowlist are environment variables. They are not hardcoded in the phone server. Add these lines to `~/.config/intelio/pwa.env` (mode 600), then restart only the phone service:

```sh
INTELIO_PWA_ACCESS=1
INTELIO_PWA_LOCAL_PORT=8644
INTELIO_PWA_ACCESS_TEAM=https://muddy-scene-4e1c.cloudflareaccess.com
INTELIO_PWA_ACCESS_AUD=9244bb370c6284088828a165bb1f0b08f52f49e57f7df871c4b5b92c9ec32108
INTELIO_PWA_ACCESS_EMAILS=hayden@intelio.co
```

```sh
systemctl --user restart intelio-pwa.service
```

A valid `Cf-Access-Jwt-Assertion` is Hayden’s human identity, including the vault. A request on `127.0.0.1:8644` with no valid JWT and no matching profile key is 401, except static files and the manifest. A wrong profile key is 401 and does not fall through. The shared :99 browser is proxied at `/browser/websockify` on this same origin (view-only until Take control). The process does not log the JWT or the profile key. `start_url` and `scope` stay `/`. Add to Home Screen uses the manifest, icons, and apple touch icon. This restart does not restart `hermes-gateway`.

## What you do

1. Run the `windows-installer` workflow on this branch and download `Intelio-Setup-*.exe` from the artifact or the draft release. This change does not publish a new installer.
2. On the PC: SmartScreen → More info → Run anyway. Install. Install or connect Tailscale. Put `remote-hermes-key.import` in the Hermes Workspace folder and launch. You do not type the key.
3. On the VPS: `chmod 600` the intelio profile env file, then run the upgrade command above. Do not commit the key, the cert, or `pwa.env`.
