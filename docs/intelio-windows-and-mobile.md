# Intelio on Windows and on a phone

The VPS Hermes (`intelio-vps.tail9c1007.ts.net`, port 8642, profile `intelio`) stays the only brain. The Windows app and the phone are thin clients. They never ship an API key, and they never open a public port.

The phone is a small installable web app plus a session proxy, not a second native codebase. It is served on the tailnet, the profile key is typed once into a login form, and the proxy keeps that key in memory. The page JavaScript never contains it. An Expo app would still need the same tailnet proxy, plus a store or a sideload, so the web app is the client that matches this setup.

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

Paste the profile `API_SERVER_KEY` once under Settings → Remote Hermes (VPS). Electron `safeStorage` encrypts it with Windows DPAPI into `remote-hermes-keys.json`. The key stays in the main process. Local Hermes remains available if you later point the app at a `hermes` on PATH; it is not required for this mode. Loading the Intelio profile still wants Python 3 and PyYAML on the machine. Chatting with the VPS does not.

The first window checks Tailscale (`tailscale version`, then `tailscale status --json`). If it is missing, the dialog offers **Install Tailscale**, which opens `https://tailscale.com/download/windows`. If it is installed but signed out, the dialog says to connect. Settings keeps the same status and the install button whenever Tailscale is not connected. Nothing in the app is reachable from the public internet; the host check still refuses a non-tailnet address before any request.

### SmartScreen

The executable is unsigned. Windows shows Microsoft Defender SmartScreen (“Windows protected your PC”). Choose **More info**, then **Run anyway**. That step goes away only after the installer is signed with a certificate Hayden trusts. Do not host the file on a public download page. The GitHub Release created by the workflow below is a **draft** on this private repository.

### GitHub Actions

`.github/workflows/windows-installer.yml` runs on `windows-latest` for **Run workflow** (`workflow_dispatch`) and for tags `v*`. It uploads `Intelio-Setup` as a workflow artifact and creates a draft release (`gh release create --draft`) with the same `.exe`. It does not publish the release. Re-running on the same commit tries to create the tag `windows-build-<sha>` again; delete that draft first if GitHub says the tag exists.

Dispatch it from the Actions tab on this branch: `windows-installer` → Run workflow. The run URL looks like `https://github.com/inteliodev/alans-way/actions/workflows/windows-installer.yml`.

## Phone

`mobile/pwa/` is a static page (`public/`) and `server.cjs` (Node’s standard library only).

- Bind address is required (`INTELIO_PWA_BIND`). It must pass the same tailnet-or-loopback check as the desktop client. A public name or a wildcard bind exits before listen.
- Default port `8643`. Upstream defaults to `http://127.0.0.1:8642` on the VPS, profile `intelio`.
- `POST /session` checks the key with `GET /p/intelio/v1/capabilities`, then sets an HttpOnly `SameSite=Strict` cookie for 12 hours. The key lives in that process’s memory and is dropped on restart. Eight failures from one address in ten minutes get HTTP 429.
- The page calls same-origin `/api/sessions`, messages, and `/api/sessions/:id/chat`. The proxy adds the bearer and streams SSE. Cross-origin requests are refused.
- Icons are the harness mark scaled to 192 and 512. `manifest.webmanifest` and `sw.js` are what the browser uses for Add to Home Screen. iPhone: Share → Add to Home Screen. Android: menu → Install app. A service worker needs a secure context, so install is reliable on `https://` (see below) and on localhost. Plain HTTP on the tailnet still loads the chat.

### Put it on the VPS

Do this on the VPS, over Tailscale, as the desktop user. This repository does not deploy it for you.

```sh
# On the VPS, from a checkout of this repo. Use the MagicDNS name or `tailscale ip -4`.
export INTELIO_PWA_BIND=intelio-vps.tail9c1007.ts.net
export INTELIO_PWA_PORT=8643
# Optional, recommended so Add to Home Screen gets a trusted tailnet certificate:
#   cd ~/.config/intelio && tailscale cert intelio-vps.tail9c1007.ts.net
#   export INTELIO_PWA_CERT=$HOME/.config/intelio/intelio-vps.tail9c1007.ts.net.crt
#   export INTELIO_PWA_KEY=$HOME/.config/intelio/intelio-vps.tail9c1007.ts.net.key
#   chmod 600 "$INTELIO_PWA_CERT" "$INTELIO_PWA_KEY"
bash mobile/deploy/install-on-vps.sh
```

The script writes `~/.config/intelio/pwa.env` (mode 600, no API key), installs the systemd **user** unit `intelio-pwa.service`, enables it, and runs:

```sh
sudo ufw allow in on tailscale0 to any port 8643 proto tcp comment 'Intelio phone client, tailnet only'
```

That rule is interface-scoped. Do not add the port on the public interface, and leave the Hostinger firewall on port 22 only. If the user service should keep running after logout: `sudo loginctl enable-linger "$USER"`.

`bash mobile/deploy/install-on-vps.sh --dry-run` prints the bind and the ufw line and changes nothing. A public bind fails the dry run.

Open `http://intelio-vps.tail9c1007.ts.net:8643` (or `https://` after `tailscale cert`) from a phone that is on the tailnet. Sign in with the intelio profile key. Telegram, app, and CLI sessions are the same list the desktop uses.

## What you do

1. Run the `windows-installer` workflow on this branch and download `Intelio-Setup-*.exe` from the artifact or the draft release.
2. On the PC: SmartScreen → More info → Run anyway. Install. Install or connect Tailscale. Paste the intelio `API_SERVER_KEY` once.
3. On the VPS: run `mobile/deploy/install-on-vps.sh` as above. Do not commit the key, the cert, or `pwa.env`.
