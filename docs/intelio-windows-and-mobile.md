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

The installer is one-click and per-user (no admin prompt): Start menu shortcut and a desktop shortcut, both named intelio. It packages the desktop app as it is, including the intelio profile, brand, and Remote Hermes client under `resources/intelio-repo`. It does not include a copy of upstream Hermes. The executable stays unsigned (`signExecutable: false`). electron-builder still writes the version resource, so FileDescription and ProductName are intelio.

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

`.github/workflows/windows-installer.yml` runs on `windows-latest` for **Run workflow** (`workflow_dispatch`), for tags `v*`, and for pushes to `cursor/intelio-harness-layer-8db4`. It first runs the `tests` workflow for the same commit and builds nothing unless that passes. It uploads `Intelio-Setup` as a workflow artifact. A tag push names the draft release after that tag. A branch push attaches `Intelio-Setup-<version>.exe` to the draft release `v<version>-intelio-windows`, where `<version>` is read from `desktop/package.json` (the only place the version is written), creating it or replacing the asset if that draft already exists. After the installer is built, the workflow runs `intelio.exe --smoke-test`, then launches that packaged app against a fake Hermes behind a fake Access login and checks that the sign-in screen appears, that Auto falls back to Cloud when the Tailscale host is unreachable, that bootstrap fills the profile keys, and that the main window then shows four agents with that agent's threads underneath, and keeps the remote Hermes version (`hermes-agent 0.21.5 · Cloud` from `/health`) with no “unavailable” or error text. The VPS host and version stay in Settings, not the sidebar. It checks that those threads are listed under the agents, and that the visible window text does not contain “Alan”. Screenshots are the `intelio-e2e-main-window` workflow artifact. The same workflow also builds an unsigned Apple Silicon zip, `Intelio-<version>-mac-arm64.zip`, and attaches it to that draft. A fresh macOS launch uses the four VPS harness profiles. It does not publish the release.

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

### Saved logins (vault v2)

Vault profiles are the directories under `~/.hermes/profiles` plus `hermes profile list`. The vault itself lives outside `~/.hermes`, so a Hermes update cannot collide with it (Hermes core keeps its own model-blind vault in `~/.hermes/profiles/<profile>/vault/`, a directory; intelio never reads or writes it):

- data: `~/.local/share/intelio/vault/<profile>.vault` (folder 0700, file 0600, atomic writes). `INTELIO_VAULT_DIR` moves it.
- key: one 32-byte master key, apart from the data. First found of `$CREDENTIALS_DIRECTORY/intelio-vault.key` (systemd credential), `INTELIO_VAULT_KEY_FILE`, `~/.config/intelio/keys/vault.key` (folder 0700, file 0600). A group- or world-readable key file is tightened to 0600; one owned by another user is refused. The key may not sit inside the data folder or `~/.hermes`.
- crypto: AES-256-GCM with a per-agent key `HKDF-SHA256(master, salt "intelio-vault/v2", info "login-vault:<profile>")`; the agent id is also the additional data. A file copied to another agent does not open.
- a v1 file at `~/.hermes/profiles/<profile>/vault` (key beside it) is migrated on first use, checked, and removed.

The desktop app's local (non-remote) vault wraps its master key with the OS keychain through Electron `safeStorage`.

On systemd 256 or newer the key can be held encrypted at rest by systemd-creds:

```sh
systemd-creds encrypt --name=intelio-vault.key --uid="$(id -u)" \
  ~/.config/intelio/keys/vault.key /etc/credstore.encrypted/intelio-vault
```

```
[Service]
LoadCredentialEncrypted=intelio-vault.key:/etc/credstore.encrypted/intelio-vault
```

Same-user limit: Hermes agents with a terminal tool run as the same Unix user as the PWA service, so a determined agent could read the key file. Full isolation needs the PWA service (the filler) under its own user.

### Sign-in card

The PWA service looks for a visible sign-in form in each agent browser that has `bot-desktop/cdp.url` or `allow-shared-browser` (every 6 s, `INTELIO_LOGIN_WATCH_MS`, `0` turns it off; also on each chat poll). The scan reads booleans only: a password box is showing and empty, or a username-first page. With a saved login for that site it fills and submits it, and the chat shows “Signed in with saved login for github.com”. Without one the chat shows a card: “intelio is trying to sign in to github.com”, username, masked password with Show, “Remember for this agent” (on), Cancel and Sign in. The values go to `POST /api/vault/login`, are typed into the page, and are saved only when Remember is on. If the same form comes straight back, the card says the login did not work; it does not retry by itself. Cancel keeps that site quiet for 10 minutes.

Routes (profile key, Access, or Tailscale identity as for the other vault routes): `GET /api/vault/prompts?profile=`, `POST /api/vault/prompt` (`{site, reason, wait}`), `POST /api/vault/dismiss`, `GET /api/vault/logins?all=1` (every agent, for a signed-in person only; a profile key sees its own). No response or log carries a password.

The `intelio-vault` plugin adds `request_login(site, reason, wait_seconds)`. It uses the saved login, or shows the card and waits up to 110 s, and returns only ok, filled, saved, pending, status, domain and username. Restart `hermes-gateway` after copying the plugin to register it.

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

A login wall shows an in-chat Secure Sign-in card: site mark, domain, username, masked password, masked one-time code, Save login, Submit, and Do it on screen. Submit sends those values write-only over the authenticated harness channel to the filler. They are not copied into the task, the model context, transcripts, or logs. Save login stores them in that profile’s encrypted vault (see Saved logins above). PRC cannot read HHP. Settings lists site and username only, and can delete a row. `fill_saved_login(site)` returns domain and username. The secret stays in the filler payload.

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

A valid `Cf-Access-Jwt-Assertion` header, or the same JWT in the `CF_Authorization` cookie, is Hayden’s human identity, including the vault and the browser websocket. A request on `127.0.0.1:8644` with no valid JWT and no matching profile key is 401, except static files and the manifest. A wrong profile key is 401 and does not fall through. The shared :99 browser is proxied at `/browser/websockify` on this same origin (view-only until Take control). Set `INTELIO_PWA_VNC_URL` to the websockify the desktop already uses (http on port 6080). When that variable is unset, the phone dials port 6080 on `INTELIO_PWA_BIND`. The URL must be tailnet or loopback and must not include a password. The desktop `vnc=` secret is read on the server from `INTELIO_VNC_PASSWORD` or from a mode-600 file named by `INTELIO_VNC_PASSWORD_FILE` (one `vnc=` line, the same import format as the desktop). It is not sent to the phone and it is not logged. Settings lists saved logins (domain and username) and opens the secure sign-in card. The browser sheet’s lock opens that card for the current site. The process does not log the JWT, the profile key, or the VNC password. `start_url` and `scope` stay `/`. Add to Home Screen uses the manifest, icons, and apple touch icon. This restart does not restart `hermes-gateway`.

## Agent profile (0.3.12)

The desktop right panel, and the phone browser sheet, lead with `<Agent>'s computer` and the agent name. The agent page is the profile for Intelio, PRC, Alignment, and HHP only. It shows the existing orb, message, call, video (soon), and email. Details, Memory, and Phone sit under that. The iMessage number is read from that profile's `config.yaml` on the VPS (`phone`, `imessage`, `photon`, `sms`, `twilio`, or `mobile`). A known number is used only when the file has none. Email, toolsets, and reasoning effort come from the same file. Reasoning is written back only when the file already has a model block or a reasoning line. Works-on stays Cloud. Routines are that profile's Hermes jobs. Where to find the agent reads the gateway platforms in the config. Share contact copies the name, number, and email. Pause asks first, then writes a mode-600 `intelio-paused` marker in the profile directory. Memory is `USER.md` and `MEMORY.md`, read-only, with search. Lines that look like keys, tokens, or secrets are left out of the page and the JSON. The phone client version is `intelio-pwa-10`. The service worker cache is `intelio-pwa-12`: `/`, `index.html`, `app.js`, and `app.css` load from the network first, and a phone that already had the app shows “New version. Tap to reload.” Chat, including loaded API, Telegram, and iMessage threads, shows the user line and the assistant's final reply as bubbles. Tool calls, tool results, and untrusted-data wrappers collapse to a status chip, with a spinner while the tool is running. The chip opens the plain detail. Raw JSON is not the bubble. The desktop draft tag is `v0.3.12-intelio-windows`. It stays unpublished.

## 0.3.13

Light-mode agent details use dark text and visible borders, including the Details tab. A run of tool steps between a message and the reply is one chip, “Worked through N steps”, with the latest step name while it is still running. Friendly names stay (a page, a command, files); the labels Tool Call and Tool Describe do not. The computer view scales the remote screen to the panel and keeps its aspect, on the desktop and the phone. The window title, menu, and installer name are Intelio. The app icon is the earlier black rounded square with two white marks, on Windows, Mac, the title bar, and the phone home screen. Agent orbs are unchanged. The phone client version is `intelio-pwa-11`. The service worker cache is `intelio-pwa-13`. The desktop draft tag is `v0.3.13-intelio-windows`. It stays unpublished.

## 0.3.14

The window title, Start menu shortcut, desktop shortcut, installer, uninstaller, and executable are Intelio. A profile id `intelio` is shown as Intelio in the sidebar, the chat header, threads, the agent tab, and sessions. The id itself stays lowercase. Thread rows do not show source tags (API, Telegram, photon/iMessage, One-shot). Live chat keeps the user’s message as one bubble. Under it, once the agent has the message, a grey “Read” time sits on the right. Progress stays in the thread under that bubble: an acknowledgement when the agent writes one, then one chip per step (a spinner while it runs, a check when it is done) named for the activity, then Stop all. The reply collapses those steps into “Worked through N steps”. The header under the orb says “Working on N things” while work is running, and the agent name when it is idle. Light mode uses a white chat panel, a near-black user bubble, and a light grey agent bubble. The phone client version is `intelio-pwa-12`. The service worker cache is `intelio-pwa-14`. The desktop draft tag is `v0.3.14-intelio-windows`. It stays unpublished.

## 0.3.15

The saved theme in `preferences.json` is the theme on startup. Light stays light. The preferences file stays in Hermes Workspace, including after the executable name changes. The computer view scales the remote desktop down so the whole frame fits inside the panel, centered, on the desktop and the phone. It does not clip the right edge and it does not ask the VPS to resize. The window title, menu, sidebar, Start menu shortcut, uninstaller, About box, phone home-screen name, and the intelio agent are intelio. PRC, Alignment, and HHP stay as they are. Task Manager reads FileDescription and ProductName intelio. A single sentence is one Hermes session. The chat pill and a sidebar orb open that agent's Details, Memory, and Phone page. If the computer is only a floating preview, that click brings the agent page back. Add agent, the + beside search and the agent count, asks for a name, an optional title, an orb style, and optional SOUL text. The phone server creates an isolated Hermes profile from the intelio template: the same ChatGPT/Codex provider, the same safe toolsets, and the intelio toolset. Telegram, Photon, and the shared browser stay off. It does not read or change `~/.hermes/auth.json`, it does not run `hermes auth`, and it does not restart `hermes-gateway`. The new row says Needs sign-in when the template cannot lend model access without that file, and Ready after the next agent restart until the gateway is restarted by hand. The sidebar lists VPS profiles and leaves out Kid A and Alignment-Bot-VPS. The phone client version is `intelio-pwa-13`. The service worker cache is `intelio-pwa-15`. The desktop draft tag is `v0.3.15-intelio-windows`. It stays unpublished.

Deploying Add agent: copy `mobile/pwa/profiles.cjs`, `mobile/pwa/server.cjs`, and `mobile/pwa/public/` (`app.js`, `app.css`, `sw.js`) onto the VPS phone server, then `systemctl --user restart intelio-pwa.service`. Do not restart `hermes-gateway` as part of that deploy. A new profile is served by the gateway only after the next agent restart, which is a separate decision.

## 0.3.16

Desktop and phone. The Watching header is one left-aligned WATCHING label. The sidebar toggle sits at the top-left of the chat and the round phone-call button sits at the top-right, with the orb and name centered between them. The selected screen pill uses the intelio accent. Agent rows show a role chip and the last message, and they leave out the persona prompt. Add agent uses stacked labeled fields, a light textarea, an orb gallery, and Cancel. The theme control is a moon or sun icon beside the settings gear and the choice is saved. An orb and color picked in Details is saved on that profile and shown in the sidebar, rows, header, and phone. The composer uses Dictate, Voice conversation, and Send icons. The top call button asks the agent to call the owner’s phone when Twilio is configured, and otherwise shows “Phone line not set up yet”. The Windows installer writes Start menu and desktop shortcuts named intelio that open intelio.exe, and it removes a leftover Intelio.lnk. The phone client version is `intelio-pwa-15`. The service worker cache is `intelio-pwa-17`. The desktop draft tag is `v0.3.16-intelio-windows`. It stays unpublished.

## 0.3.17

Desktop. Auto still tries the Tailscale host first. If that host does not answer within a few seconds, the app uses intelio cloud at `https://app.intelio-ai.com`. Settings lists the mode as intelio cloud (app.intelio-ai.com) and shows the path in use, Tailscale or intelio cloud. Cloud sign-in opens an in-app window on that host. The Cloudflare Access cookie stays in the `persist:intelio-cloud` session and is not written to preferences. Agent, session, profile, and desktop calls use that same Access listener: `/api`, `/p/<profile>/api`, `/health`, and `/browser/websockify`. When the cookie expires, a small Sign in again card appears. The Windows installer stays per-user, does not ask for administrator rights, and installs under `%LOCALAPPDATA%\Programs\intelio`. The 0.3.16 window layout is unchanged. The draft tag is `v0.3.17-intelio-windows`. It stays unpublished.

## 0.3.18

Desktop. A JSON 401 or 403 from Hermes is a profile error. It does not open the sign-in window. Sign-in opens only for a Cloudflare Access redirect (`*.cloudflareaccess.com`, `/cdn-cgi/access`, or the login page) or an HTML challenge. When the `CF_Authorization` cookie is already in the cloud session, intelio refreshes keys instead of opening another window, and it will not open a second sign-in window within 15 seconds. The sign-in window no longer loads `vnc.html`. The computer pane still uses the local viewer on the `persist:intelio-cloud` session, and that session attaches the Access cookie to the websockify handshake. Hermes requests send `x-intelio-profile`. The first-run Tailscale install dialog stays hidden when cloud mode is the connection in use. The draft tag is `v0.3.18-intelio-windows`. It stays unpublished.

A desktop-width browser at app.intelio-ai.com (about 1000px and wider) uses the same window as the laptop app: the agent sidebar, the chat, the screen pills, and the agent computer on `/browser/websockify`. The phone layout stays under that width. The phone client version is `intelio-pwa-16`. The service worker cache is `intelio-pwa-19`.

Desktop Dictate records the microphone with MediaRecorder and posts the audio to `/api/voice/stt` on the active connection (Tailscale port 8643, or the intelio cloud Access listener on 8644 with the profile key and `x-intelio-profile`). The voice conversation uses the same routes for hands-free listening and sentence-by-sentence playback through `/api/voice/tts`. Speech to text is faster-whisper (base, int8) and speech is Piper (`en_US-lessac-medium`) on the phone server. When `/v1/capabilities` advertises Hermes audio, that engine is used. If the voice worker is not installed, the composer says `Voice isn't set up on the server yet`. The microphone permission is granted only for intelio's own windows.

The window stays one screen tall (`100dvh`, overflow hidden). The sidebar, the message list, and the Details card each scroll on their own. A long Details card does not push the composer off the screen, and opening a chat or sending a message scrolls the message list to the newest line. The Details tab is named for the agent on that card.

The Access listener on the VPS has to be the copy that proxies `/health`, `/p/<profile>/api`, `/p/<profile>/v1`, and `/intelio/bootstrap`. Copy `mobile/pwa/server.cjs` and `mobile/pwa/profiles.cjs` onto the phone server. The phone unit needs `Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin` (re-run `mobile/deploy/install-on-vps.sh`, or add that line to the unit). Then `systemctl --user restart intelio-pwa.service`. Do not restart `hermes-gateway` as part of that deploy.

## 0.3.19

The chat composer has a model pill to the left of the microphone on the desktop window and on the phone. The label is the model for the current thread. The menu lists models Hermes returns for the signed-in ChatGPT/Codex provider and, when that row is an OAuth subscription, Claude. API-key providers are left out. Nothing in the menu is a hardcoded model list, and the app does not read `auth.json` or call `chatgpt.com`. Choosing a model switches that thread the same way `/model` does. Make default writes only `model.provider` and `model.default` in that profile's `config.yaml` after a backup. Hermes does not need a gateway restart for a new thread, so intelio does not restart one. The note says new threads use the model and this thread keeps its own. Thinking in the same menu is Auto, Low, Medium, or High. The routes are `/api/models`, `/api/sessions/<id>/model`, and `/api/agent/model`, on Tailscale port 8643 and the Access listener on 8644, with the profile key. Phone client `intelio-pwa-17`. Service worker cache `intelio-pwa-20`. The draft tag is `v0.3.19-intelio-windows`. It stays unpublished.

Copy `mobile/pwa/server.cjs` and the phone public files onto the VPS, then `systemctl --user restart intelio-pwa.service`. Do not restart `hermes-gateway`.

## 0.3.21

The Claude sign-in row from 0.3.20 is removed, and the phone server no longer starts any `hermes ... auth` command. The model menu still lists only what Hermes already reports for that agent: the ChatGPT/Codex subscription, and Claude only when Hermes already has a Claude OAuth subscription row. API-key providers stay out. intelio does not read or write `auth.json`.

The desktop window keeps the top-right buttons clear of Call my phone, shows a VPS desktop · connected/disconnected chip, shows Online, Offline · reconnecting or Connecting… on the agent card from the real agent list load, restores a minimized window on relaunch, and puts Quit under File and About under Help on Windows. Phone client `intelio-pwa-19`. Service worker cache `intelio-pwa-22`. The draft tag is `v0.3.21-intelio-windows`. It stays unpublished.

Copy `mobile/pwa/server.cjs` and the phone public files onto the VPS, then `systemctl --user restart intelio-pwa.service`. Leave `hermes-gateway` running.

## 0.3.22

The desktop window has a Sessions tab next to Agents. It groups sessions by date, filters by agent, and can rename, pin, archive or delete one session. The phone server forwards PATCH and DELETE only for `/api/sessions/<id>`, on Tailscale port 8643 and the Access listener on 8644, with the profile key. Rename sends only the title, pin and archive flags. Claude sign-in stays removed; the phone server starts no `hermes ... auth` command and does not read or write `auth.json`. Phone client `intelio-pwa-20`. Service worker cache `intelio-pwa-23`. The draft tag is `v0.3.22-intelio-windows`. It stays unpublished.

Copy `mobile/pwa/server.cjs` and the phone public files onto the VPS, then `systemctl --user restart intelio-pwa.service`. Leave `hermes-gateway` running.

## 0.3.23

The desktop chat shows Hermes's thinking as bubbles in the thread, keeps the chat in a centered column, and the Sessions tab uses a Hermes-style list. The phone server and the phone bridge are unchanged from 0.3.22. Claude sign-in stays removed; the phone server starts no `hermes ... auth` command and does not read or write `auth.json`. Phone client `intelio-pwa-21`. Service worker cache `intelio-pwa-24`. The draft tag is `v0.3.23-intelio-windows`. It stays unpublished.

Copy `mobile/pwa/server.cjs` and the phone public files onto the VPS, then `systemctl --user restart intelio-pwa.service`. Leave `hermes-gateway` running.

## 0.3.24

The Sessions tab has a client row: All, intelio, PRC, Alignment, HHP and ARLP. Picking a client filters the sessions and shows that client's work apps (Google Workspace for intelio and PRC, Microsoft 365 for Alignment, HHP and ARLP) with a green dot when that client's browser is signed in and a grey dot when it is not. Each client opens in its own persistent browser partition (`persist:client-<id>`), so sign-ins never share cookies. More lists the rest of the apps, Set account email, and Sign out of this client. Nothing here gives an agent access; that stays in the agent's Hermes connections. The phone server only adds `intelio/client-apps.cjs` to the UI files it serves. Claude sign-in stays removed; the phone server starts no `hermes ... auth` command and does not read or write `auth.json`. Phone client `intelio-pwa-22`. Service worker cache `intelio-pwa-25`. The draft tag is `v0.3.24-intelio-windows`. It stays unpublished.

Copy `mobile/pwa/server.cjs` and the phone public files onto the VPS, then `systemctl --user restart intelio-pwa.service`. Leave `hermes-gateway` running.

## 0.3.28

Themes come in three, in this order: Light, Blue and Dark. The bottom-left button cycles light → blue → dark and Settings → Appearance lists Light / Blue / Dark, on desktop and phone. Blue is white on electric blue (`#0000e8`) with pale-blue accents (`#cfdcff`). The Watching section is gone from the Agents sidebar; screens stay on the top-right grid.

Sessions has one agent dropdown (All agents, then each agent) in place of the colored chips. The choice is remembered. The selected thread in the agent sidebar is now a dark row in dark mode (it was a light-grey fill under white text).

Saved logins: when an agent reaches a sign-in page, the chat shows a card with username, masked password, Remember for this agent, Cancel and Sign in. The vault lives at `~/.local/share/intelio/vault/<profile>.vault` with a per-agent key. Settings lists saved logins (site, username, agent, last use) for every agent. The `intelio-vault` Hermes plugin adds `request_login`; copy `plugins/intelio-vault` into `~/.hermes/plugins/intelio-vault` and each profile's `plugins/intelio-vault`, then restart `hermes-gateway` once when Hermes is idle.

Home, missions and the Ctrl/Cmd+K command bar (and install a skill from a link). Ctrl/Cmd+K is taken only when focus is in intelio itself; a page in an agent browser tab keeps its own shortcut. Skill installs write only under `~/.hermes/profiles/<profile>/skills/`.

Accounts page per agent and Settings › Activity log.

Phone client `intelio-pwa-26`. Service worker cache `intelio-pwa-30`. Asset query `?v=29`. On the VPS: check out the release, run `mobile/deploy/install-on-vps.sh --with-voice` (restarts `intelio-pwa`).

## 0.3.27

New agents work right away. `/intelio/bootstrap` returns the key for every profile the VPS lists, not just intelio, prc, alignment and hhp, so an agent made after the first sign-in (arlp) gets its key. It is still Access sign-in only. The app fetches keys again in the background on start, after creating an agent, and when an agent without a key is picked; that fetch uses the cloud sign-in even when the app is on Tailscale. A new profile copies the template's `base_url`, and `POST /api/profiles` checks it on its own `/p/<name>/v1/capabilities` route instead of saying "Ready after the next agent restart".

Voice conversation ends a turn after 1.2 s of quiet (was 0.7 s) and drops bursts under 0.3 s; start and keep levels follow the room's noise floor. While the agent is speaking, only clearly louder speech held for 0.35 s interrupts it, so its own echo no longer cuts it off. The recorder runs for the whole conversation, so turns keep their first syllable, and mic checks run on a 30 ms timer instead of animation frames. The phone web app sends one call turn at a time. Shared `createTurnDetector` in `desktop-voice.cjs`.

Phone calls no longer hang up after the greeting: the bridge reads the session id from `session.id` and gives each call a unique title (`Phone call <date, time> · <last 6 of CallSid>`). `/api/home` caches `/v1/skills` per profile (a good list for 60 s, an HTTP error for 15 min), so an erroring profile is no longer asked on every refresh.

Phone client `intelio-pwa-25`. Service worker cache `intelio-pwa-29`. Asset query `?v=28`. Copy `mobile/pwa/server.cjs` and the phone public files onto the VPS (`mobile/deploy/install-on-vps.sh --with-voice`), restart `intelio-pwa` and `intelio-phone-bridge`. Leave `hermes-gateway` running.

## 0.3.26

Chat shows one typing bubble while the agent works: three dots, a short status such as "Reading files…", and a small stop button on the bubble. The reply replaces the bubble. Tool-step pills, "Worked through N steps" and "Stop all" are no longer shown in the desktop chat, the Window > Remote Hermes (VPS) chat or the phone/web chat. Display only: runs, streaming and stored sessions are unchanged.

The macOS arm64 zip now carries `Contents/Resources/intelio-repo` (the same profile, Python and harness files as the Windows build), so the app starts. Earlier Mac zips threw on start because `forks.json` was missing. CI checks the zip listing and runs the packaged app with `--smoke-test` on macOS before attaching it to the draft.

Copy `mobile/pwa/server.cjs` and the phone public files onto the VPS, then `systemctl --user restart intelio-pwa.service`. Leave `hermes-gateway` running.

## 0.3.25

Faster and steadier on the VPS route. New installs and unknown connection settings go straight to the VPS address (`cloud`); Tailscale is used only when chosen (`auto` or `tailscale`) in Settings, and existing saved choices are kept. The agent list answers at once from the last list the server returned and refreshes in the background; an expired cloud sign-in still shows on the next refresh. `/api/home` waits up to 12 s (was 3 s) and a timeout no longer falls through to `/api/profiles`; agent cards, screens and other phone-server calls wait up to 10 s (was 1.2 s). Agent computer screens load on their own, so chat and sessions never wait for them. The phone server skips the header row of `hermes profile list`, so no phantom agent called "profile" appears. Claude sign-in stays removed; the phone server starts no `hermes ... auth` command and does not read or write `auth.json`. Phone client `intelio-pwa-23`. Service worker cache `intelio-pwa-26`. The draft tag is `v0.3.25-intelio-windows`. It stays unpublished.

Copy `mobile/pwa/server.cjs`, `mobile/pwa/profiles.cjs` and the phone public files onto the VPS, then `systemctl --user restart intelio-pwa.service`. Leave `hermes-gateway` running.

## What you do

1. Run the `windows-installer` workflow on this branch and download `Intelio-Setup-*.exe` from the artifact or the draft release. This change does not publish a new installer.
2. On the PC: SmartScreen → More info → Run anyway. Install. It does not ask for administrator rights. A laptop on Tailscale keeps using the tailnet. A PC that cannot reach Tailscale, including Hayden’s ARLP machine, signs in at app.intelio-ai.com. Put `remote-hermes-key.import` in the Hermes Workspace folder only if that sign-in has not supplied the keys. You do not type the key.
3. On the VPS: `chmod 600` the intelio profile env file, then run the upgrade command above. Do not commit the key, the cert, or `pwa.env`.
