# Intelio on Alan's Way

This fork keeps [Alan's Way](https://github.com/capthvnsen/alans-way) (Alex Hansen, MIT for the companion, GPL-3.0-or-later for the desktop app) and runs an Intelio profile on top. Hermes and Nous Research strings in the upstream app are unchanged. The Intelio layer lives under `intelio/` plus a thin desktop bridge:

- `desktop/src/intelio/` loads the profile and enforces browsing-zone and ask-first rules
- `desktop/src/intelio.css`, `desktop/src/intelio-ui.js`, and small hooks in `desktop/src/main.cjs`, `renderer.js`, and `index.html` apply the brand and the profile/pin status

## How the harness is consumed

The private repo `inteliodev/intelio-harness` was not readable from this workspace (GitHub 404). Rather than re-implement the whole harness inside the Electron app, the fork vendors only the contract files (`pin/`, `schema/`, `brand/`) and ships a stdlib loader with the same entry point:

```sh
PYTHONPATH=intelio/python python -m intelio_harness intelio/profiles/example
```

The loader refuses to start when `profile.yaml` or `pin/hermes.yaml` is missing, and it exits non-zero without a success report. It does not read the profile `.env`, does not vendor Hermes, and does not treat a failed `hermes` process as a match. See [intelio/SYNC.md](intelio/SYNC.md) for how to replace the vendor tree with the real repo.

The example profile's `hermes_profile: example` maps to `hermes -p example`. An empty `hermes_profile` maps to `hermes` with no `-p`. The desktop app probes `hermes -p <name> --version` (or `hermes --version`) and shows the pin commit next to that result. It does not start a Hermes chat.

## Run the desktop app

From a checkout, with Node 20+ and Python 3.11+:

```sh
cd desktop
npm ci
npm run build:preload
npm start
```

The app loads `intelio/profiles/example` unless you pass `--profile <dir>`, set `INTELIO_PROFILE`, or save a directory under Settings → Intelio profile. The window title and sidebar use `brand/window-title.txt` (`Intelio`) plus the profile name. Alan's Way stays credited in the sidebar.

On Linux, including this demo VM, the upstream app targets an Apple Silicon Mac and the Electron sandbox needs a flag that Mac launches do not use:

```sh
cd desktop
INTELIO_LINUX_DEMO=1 HERMES_WORKSPACE_DATA=/tmp/intelio-alans-way-demo npm start
```

`INTELIO_LINUX_DEMO=1` is Linux-only. It turns off the Electron sandbox (including per-view `sandbox`, which this VM's Chromium zygote needs or the shell renderer exits 5), `/dev/shm`, and GPU switches so the shell can open under Xvfb. It does not change the Mac path, and it does not relax tab ownership, the browsing zone, or the safety defaults.

## Safety defaults

These are on for every profile. A profile that sets `yolo: true` or a consequential mode other than `ask` is refused. `INTELIO_YOLO` is ignored.

- No YOLO.
- Consequential actions stay ask-first: external messages, purchases, credential or permission changes, production changes, and destructive operations. Agent navigation to payment hosts (`stripe.com`, `paypal.com`) or `/checkout`, `/payment`, `/billing`, and destructive account paths returns `approval_required` and does not run. An `approved` flag on the request does not bypass that.
- Bots still only see tabs they own or that you grant. Upstream handoff and control-epoch checks are unchanged.
- Credentials stay vault-blind. The loader never reads `.env`. Probe errors are redacted. Bot-visible state does not include the env file.
- `browsing_origins`, when non-empty, denies agent navigation outside those origins. An empty list adds no extra zone. `allowed_folders` bounds Intelio-layer local reads (`intelio_harness.files`). Relative folders cannot traverse out of the profile directory. The example profile allows `intelio/profiles/example/files` (named `files` because the repo gitignore ignores every `workspace/` directory).

## Checks

```sh
cd desktop && npm run check
PYTHONPATH=intelio/python python -m unittest discover -s tests -v
```

## Not wired

- The real `inteliodev/intelio-harness` package or submodule (blocked on repo access). The pin is a labeled stand-in of upstream Hermes `main`, not a file copied from the harness.
- Spawning a Hermes gateway or TUI. The app only probes `hermes --version`.
- Installing profile `skills` into Hermes, or hiding panes based on `panels`. Both are shown in Settings.
- The companion Mac file server (`hermes_companion.mac_server`) still uses its own `--workspace` and still refuses non-Darwin hosts. Call `intelio_harness.files.ensure_allowed` before pointing it at a folder if you want the profile bound there.
- Telegram sign-in, a live VPS, and noVNC. Those stay empty or disconnected until you sign in and paste a viewer URL.
- `alans-way-agents` is a separate repo and is not modified here.
