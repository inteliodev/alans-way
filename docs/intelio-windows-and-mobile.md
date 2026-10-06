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

On Windows, when there is no preferences file yet, Remote Hermes is already on:

- host `intelio-vps.tail9c1007.ts.net`
- port `8642`
- profile `intelio`

Do not type or paste the profile key. Before launch, place `remote-hermes-key.import` in the app data folder (`Hermes Workspace`, under `%APPDATA%` on Windows and `~/Library/Application Support` on macOS). The file is one line: the raw key, or `API_SERVER_KEY=...`. On startup Intelio encrypts it with Electron `safeStorage` (Windows DPAPI, macOS Keychain, or libsecret) into `remote-hermes-keys.json` (mode 600), the same store Settings uses, overwrites the import file with zeros, and deletes it. The window then shows **Connected to VPS Hermes**. If the operating system cannot encrypt, the import file is left in place and nothing is stored. The key stays in the main process. After a rotation, drop a fresh import file before the next launch so the stored key is replaced. Local Hermes remains available if you later point the app at a `hermes` on PATH; it is not required for this mode. Loading the Intelio profile still wants Python 3 and PyYAML on the machine. Chatting with the VPS does not.

The first window checks Tailscale (`tailscale version`, then `tailscale status --json`). If it is missing, the dialog offers **Install Tailscale**, which opens `https://tailscale.com/download/windows`. If it is installed but signed out, the dialog says to connect. Settings keeps the same status and the install button whenever Tailscale is not connected. Nothing in the app is reachable from the public internet; the host check still refuses a non-tailnet address before any request.

### SmartScreen

The executable is unsigned. Windows shows Microsoft Defender SmartScreen (“Windows protected your PC”). Choose **More info**, then **Run anyway**. That step goes away only after the installer is signed with a certificate Hayden trusts. Do not host the file on a public download page. The GitHub Release created by the workflow below is a **draft** on this private repository.

### GitHub Actions

`.github/workflows/windows-installer.yml` runs on `windows-latest` for **Run workflow** (`workflow_dispatch`) and for tags `v*`. It uploads `Intelio-Setup` as a workflow artifact and creates a draft release (`gh release create --draft`) with the same `.exe`. It does not publish the release. Re-running on the same commit tries to create the tag `windows-build-<sha>` again; delete that draft first if GitHub says the tag exists.

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

Open `http://intelio-vps.tail9c1007.ts.net:8643` (or `https://` after `tailscale cert`) from a phone that is on the tailnet as an allowed login. The page opens signed in. The shell is dark first, with a light theme when the phone asks for one. A clay avatar is chosen from the profile name (`intelio`, `prc`, `alignment`, `hhp`, `kid-a` in `mobile/pwa/public/avatars/`); any other name uses the Intelio avatar, which is also the home-screen icon. The bottom bar is Chat and Sessions. Library appears when `GET /v1/skills` succeeds, and Goals when `GET /api/jobs` succeeds. There is no Ideas tab. The drawer lists those tabs and the Hermes sessions. Telegram, app, and CLI sessions are the same list the desktop uses. Screenshot layouts with several profiles are sample data, labeled SAMPLE DATA, and only run when the bind is loopback.

## What you do

1. Run the `windows-installer` workflow on this branch and download `Intelio-Setup-*.exe` from the artifact or the draft release. This change does not publish a new installer.
2. On the PC: SmartScreen → More info → Run anyway. Install. Install or connect Tailscale. Put `remote-hermes-key.import` in the Hermes Workspace folder and launch. You do not type the key.
3. On the VPS: `chmod 600` the intelio profile env file, then run the upgrade command above. Do not commit the key, the cert, or `pwa.env`.
