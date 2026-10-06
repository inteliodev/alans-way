# Intelio on Alan's Way

This fork keeps [Alan's Way](https://github.com/capthvnsen/alans-way) (Alex Hansen, MIT for the companion, GPL-3.0-or-later for the desktop app) and runs an Intelio profile on top. Hermes and Nous Research strings in the upstream app are unchanged. The Intelio layer lives under `intelio/` plus a thin desktop bridge:

- `intelio/vendor/intelio-harness/` is `inteliodev/intelio-harness` at `996267ba526254310a029e3c63825561e470c654`
- `intelio/python/alans_way/` calls that loader, then applies browsing zones, ask-first safety, and the Hermes probe
- `desktop/src/intelio/` loads the combined report and enforces those rules in the shell
- `desktop/src/intelio.css`, `desktop/src/intelio-ui.js`, and small hooks in `desktop/src/main.cjs`, `renderer.js`, and `index.html` apply the brand and the profile/pin status

## How the harness is consumed

The desktop uses the real package, not a rewritten loader:

```sh
PYTHONPATH=intelio/vendor/intelio-harness/src python -m intelio_harness intelio/profiles/example --pin intelio/vendor/intelio-harness/pin/hermes.yaml
```

That command needs PyYAML (`pip install 'PyYAML>=6'`), which is the harness dependency. It prints the profile name and `hermes_commit: 5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662` (verified 2026-10-03). It refuses to start when `profile.yaml` or the pin is missing, and it does not read `.env`, vendor Hermes, or treat a failed `hermes` process as a match.

`profile.yaml` only has `name`, `panels`, `skills`, and `allowed_folders`, which is what `schema/profile.schema.json` allows. Alan's Way extras are in `alans-way.yaml` beside it. The shell loads them with:

```sh
PYTHONPATH=intelio/python:intelio/vendor/intelio-harness/src python -m alans_way intelio/profiles/example
```

`hermes_profile: example` in that sidecar maps to `hermes -p example`. An empty value maps to `hermes` with no `-p`. The app probes `hermes -p <name> --version` (or `hermes --version`) and shows the real pin commit next to that result. A short `upstream <sha>` token or `+N.g<sha>` describe suffix is compared to the pin by prefix, so a different short SHA is a mismatch rather than an unverified probe. It does not start a Hermes chat. See [intelio/SYNC.md](intelio/SYNC.md).

## Run the desktop app

From a checkout, with Node 20+ and Python 3.11+:

```sh
python3 -m pip install 'PyYAML>=6'
cd desktop
npm ci
npm run build:preload
npm start
```

The app loads `intelio/profiles/example` unless you pass `--profile <dir>`, set `INTELIO_PROFILE`, or save a directory under Settings → Intelio profile. The window title and sidebar use `brand/window-title.txt` (`Intelio`) plus the profile name, and the icon and Geist files from `brand/`. Alan's Way stays credited in the sidebar.

On Linux, including this demo VM, the upstream app targets an Apple Silicon Mac and the Electron sandbox needs a flag that Mac launches do not use:

```sh
cd desktop
INTELIO_LINUX_DEMO=1 HERMES_WORKSPACE_DATA=/tmp/intelio-alans-way-demo npm start
```

`INTELIO_LINUX_DEMO=1` is Linux-only. It turns off the Electron sandbox (including per-view `sandbox`, which this VM's Chromium zygote needs or the shell renderer exits 5), `/dev/shm`, and GPU switches so the shell can open under Xvfb. It does not change the Mac path, and it does not relax tab ownership, the browsing zone, or the safety defaults.

## Remote Hermes (VPS)

The VPS runs the single Hermes brain; this app is a client of it over Tailscale through the Hermes API server (same sessions and memory as Telegram). Configure host, port, profile and key under Settings → Remote Hermes (VPS), then open Window → Remote Hermes (VPS). Details, security model and VPS setup: [docs/intelio-remote-hermes.md](docs/intelio-remote-hermes.md). The Windows installer and the tailnet phone client are in [docs/intelio-windows-and-mobile.md](docs/intelio-windows-and-mobile.md).

## Safety defaults

These are on for every profile the shell loads. A sidecar that sets `yolo: true` or a consequential mode other than `ask` is refused. `INTELIO_YOLO` is ignored. Those keys are not part of the harness schema.

- No YOLO.
- Consequential actions stay ask-first: external messages, purchases, credential or permission changes, production changes, and destructive operations. Agent navigation to payment hosts (`stripe.com`, `paypal.com`) or `/checkout`, `/payment`, `/billing`, and destructive account paths returns `approval_required` and does not run. An `approved` flag on the request does not bypass that.
- Bots still only see tabs they own or that you grant. Upstream handoff and control-epoch checks are unchanged.
- Credentials stay vault-blind. Neither loader reads `.env`. Probe errors are redacted. Bot-visible state does not include the env file.
- `browsing_origins` in `alans-way.yaml`, when non-empty, denies agent navigation outside those origins. An empty list adds no extra zone. `allowed_folders` in `profile.yaml` are relative names. Alan's Way resolves them inside the profile directory before a local read. The example profile allows `files` (named `files` because the repo gitignore ignores every `workspace/` directory).

## VPS (Intelio)

Install the browser host from this fork. The clone URL and the agent bootstrap URL live in [`intelio/forks.json`](intelio/forks.json) (`https://github.com/inteliodev/alans-way` and `https://github.com/inteliodev/alans-way-agents`). Settings → Copy setup command and Copy setup prompt read that file. Upstream credit stays on Alex Hansen's original repository; the commands that fetch code do not.

The VPS broker (`127.0.0.1:9465`) and Chromium CDP (`127.0.0.1:9223`) enforce the same agent navigation policy as the Mac shell, through `desktop/src/intelio/safety.cjs`. Point `INTELIO_SIDECAR` or `intelioSidecar` in the broker `config.json` at an `alans-way.yaml`. If neither is set, the host uses the strict defaults: no YOLO, consequential actions ask-first, and no extra browsing zone. `INTELIO_YOLO` is ignored. `yolo: true` or a consequential mode other than `ask` refuses to start the broker. Agent navigation to payment hosts or `/checkout`, `/payment`, and `/billing` returns `approval_required`. Human navigation is not origin-gated. Both ports stay on loopback.

Reach the desktop only over Tailscale. Nothing in this path is public:

- x11vnc listens on localhost.
- websockify and noVNC listen on the tailnet address or localhost.
- The Hostinger firewall leaves only port 22 open.
- The graphical session runs as a non-root desktop user.

## Checks

```sh
python3 -m pip install 'PyYAML>=6' 'pytest>=8'
cd intelio/vendor/intelio-harness && python3 -m pytest
cd /path/to/alans-way
PYTHONPATH=src python3 -m unittest discover -s tests -v
cd desktop && npm run check
```

## Not wired

- A git submodule for `inteliodev/intelio-harness`. This checkout vendors commit `996267ba526254310a029e3c63825561e470c654` because the private repo was not cloneable from here. The files are that commit's export.
- Spawning a local Hermes gateway or TUI. The app only probes `hermes --version`. For chat it is a client of the VPS Hermes instead: see [Remote Hermes (VPS) mode](docs/intelio-remote-hermes.md).
- Installing profile `skills` into Hermes, or hiding panes based on `panels`. Both are shown in Settings.
- The companion Mac file server (`hermes_companion.mac_server`) still uses its own `--workspace` and still refuses non-Darwin hosts. Call `alans_way.files.bind_folders` before pointing it at a folder if you want the profile bound there.
- Telegram sign-in, a live VPS, and noVNC. Those stay empty or disconnected until you sign in and paste a viewer URL.
- `alans-way-agents` is a separate repo and is not modified here.
