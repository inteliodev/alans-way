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

`.github/workflows/windows-installer.yml` runs on `windows-latest` for **Run workflow** (`workflow_dispatch`), for tags `v*`, and for pushes to `cursor/intelio-harness-layer-8db4`. It uploads `Intelio-Setup` as a workflow artifact. A tag push names the draft release after that tag. A branch push attaches `Intelio-Setup-<version>.exe` to the draft release `v0.3.7-intelio-windows`, creating it or replacing the asset if that draft already exists. After the installer is built, the workflow runs `Intelio.exe --smoke-test`, then launches that packaged app against a fake Hermes behind a fake Access login and checks that the sign-in screen appears, that Auto falls back to Cloud when the Tailscale host is unreachable, that bootstrap fills the profile keys, and that the main window then shows four agents with that agent's threads underneath, and keeps the remote Hermes version (`hermes-agent 0.21.5 · Cloud` from `/health`) with no “unavailable” or error text. The VPS host and version stay in Settings, not the sidebar. It checks that those threads are listed under the agents, and that the visible window text does not contain “Alan”. Screenshots are the `intelio-e2e-main-window` workflow artifact. The same workflow also builds an unsigned Apple Silicon zip, `Intelio-<version>-mac-arm64.zip`, and attaches it to that draft. A fresh macOS launch uses the four VPS harness profiles. It does not publish the release.

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

## Bops-mode (0.3.8)

Parallel tasks are split in the Intelio app, not by a Hermes tool. A message with several lines, or two long parts joined by “and”, becomes one status pill per part. The app opens a Hermes session per part and sends them together. Stop all marks the pills stopped and drops results that arrive later. The focused pill selects that task’s caption on the Bot Desktop preview (`/api/display/ws`, one screen per profile) and draws that profile’s color on the preview chrome. The badge reads “Intelio is browsing” (or the selected agent’s name).

A login, payment, or `human_has_control` result becomes a Needs-you card. Not now pauses with the lease on the human. Open login focuses the preview. Approve on a payment card records the hold and does not submit the payment. Approve on any other card releases the lease back to the agent.

Handoff is a stub. Hermes has no peer-delegation tool in this build. “Hand this to PRC” (also Alignment, HHP, Intelio) opens a session on that profile and sends a redacted note. The other tasks stay on the current profile. Profile keys are not copied.

Four screens per agent, a dedicated email address, and a Twilio in-app waveform are follow-ups.

## What you do

1. Run the `windows-installer` workflow on this branch and download `Intelio-Setup-*.exe` from the artifact or the draft release. This change does not publish a new installer.
2. On the PC: SmartScreen → More info → Run anyway. Install. Install or connect Tailscale. Put `remote-hermes-key.import` in the Hermes Workspace folder and launch. You do not type the key.
3. On the VPS: `chmod 600` the intelio profile env file, then run the upgrade command above. Do not commit the key, the cert, or `pwa.env`.
