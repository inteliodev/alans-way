# intelio-harness

This is the Intelio harness. It is a thin layer: a Hermes pin, a profile schema, branding files, a loader that reads one profile directory, and a desktop window that shows that load. Hermes itself stays a separate install. This repository does not contain Hermes source.

## How the pieces split

One machine has one harness install. Each client has one profile folder. The Electron app or other binary you ship is a release of this harness. It is the shared program. It is not a fresh install for every profile.

A profile folder is data the harness loads. It contains `profile.yaml` (`name`, `panels`, `skills`, `allowed_folders`). Secrets for that profile stay in a `.env` file in the same folder. `.env` is uncommitted. `examples/example-client/.env.example` lists variable names and leaves the values empty.

`examples/example-client/` is a sample so the shape is easy to see. It is not a real client. Real client profiles are separate private repositories, and those repositories pin this harness. This commit does not create them.

## What to rebrand

Intelio-owned files are the ones to change when the product name or mark changes:

- window title: `brand/window-title.txt`
- icon: `brand/icon.svg`
- profile schema: `schema/profile.schema.json`, which `profile.yaml` follows

Leave Hermes and Nous Research strings as they are. There are no upstream Hermes files in this repository to edit.

## Hermes pin

`pin/hermes.yaml` is data the loader reads. It records:

- upstream `NousResearch/hermes-agent`
- commit `5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662`
- verified on GitHub on 2026-10-03

`hermes update` moves only that separate Hermes install. It does not change this repository. This repository moves its Hermes pin only when `pin/hermes.yaml` changes.

The loader refuses to start when `profile.yaml` is missing or when the pin file is missing.

```bash
PYTHONPATH=src python -m intelio_harness examples/example-client
```

A successful load prints the profile name, panels, skills, allowed folders, and the pinned commit. It does not launch Hermes.

## Desktop

`npm start` opens the Intelio desktop. The window title is the text in `brand/window-title.txt`. The icon is `brand/icon.svg`, the public site mark. Color and type follow the public site: black `#0a0a0a`, white, `#f5f5f5`, `#e5e5e5`, and Geist.

The window is this Electron app. It does not launch Hermes's own desktop process, and it does not clone or vendor the Hermes tree. A normal Hermes install stays separate. The pin in `pin/hermes.yaml` is the commit that install should be on. `hermes update` still updates only that install.

On launch the app reads the pin and loads one profile directory. The default is `examples/example-client`. Pass `--profile` to load a different directory. The Intelio profile directory and a Hermes profile name are different. The sidebar field "Hermes profile" is passed as `hermes -p <name>` when it is filled. Leave it empty to use the default Hermes profile.

From a clean checkout, with Node.js 22.12 or newer and Python 3.11 or newer:

```bash
python3 -m pip install -e .
npm install
npm start
```

```bash
npm start -- --profile path/to/profile
```

Set `INTELIO_HERMES` to an executable path when `hermes` is not on `PATH`.

The desktop opens even when `hermes` is missing. Wired actions then report that the command is not on `PATH`. They do not pretend to succeed.

### What calls the local hermes command

| Surface | Command | Not wired on that surface |
| --- | --- | --- |
| Chat | `hermes chat --oneshot --format stream-json --query-file <message>` | Markdown rendering, voice, attachments, model picker |
| Sessions | `hermes sessions list` | Resuming a row from the list |
| Bots | `hermes profile list` | Creating a bot |
| Skills | `hermes skills list` | Install and uninstall |
| Memory | `hermes memory status` | Memory graph |
| Cron | `hermes cron list`, `hermes cron status` | Create, pause, resume, edit, delete |
| Kanban | `hermes kanban list --json` | Creating and moving tasks |
| Messaging | `hermes status` | Channel setup |
| Profiles | `hermes profile list` | Create, delete, import, export |
| Settings | `hermes --version`, `hermes config get model.default --json`, `hermes config get model.provider --json`, `hermes tools --summary`, `hermes mcp list`, `hermes plugins list` | Provider, key, and theme changes |

Chat follow-ups pass `--resume` with the session id from the previous reply. The YOLO checkbox adds `--yolo` to that chat command. Stop ends the running process. The message body is written to a file and passed with `--query-file`, not placed on the command line.

Files are local. The page lists folders named in `profile.yaml` and reads text inside them. It does not scan the rest of the machine.

### What is not wired

Artifacts, Terminal, Git, and Agents are in the sidebar so the desktop has those surfaces. None of them call `hermes`. The embedded terminal, review pane, memory graph, and Command Center are not connected. Buttons for those actions are not shown.

The command palette (Ctrl+K or Ctrl+P) only jumps between these surfaces, starts a new in-window chat, or refreshes the session list. Ctrl+B hides the sidebar. Ctrl+N clears the in-window transcript. That transcript is not stored by Intelio. A Hermes session remains only when a reply returns a session id.

Launch does not execute `hermes`. The first PATH check only looks for the command. A surface runs `hermes` when you open it or press its refresh control.

```bash
python3 -m pytest
npm test
```

## Bumping the Hermes pin

1. Pick a commit on [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) and open `https://github.com/NousResearch/hermes-agent/commit/<sha>` so GitHub confirms that commit exists.
2. Edit `pin/hermes.yaml`. Set `commit` to the full 40-character SHA and set `verified_on` to the date you verified it (`YYYY-MM-DD`). Leave `upstream` as `NousResearch/hermes-agent`.
3. If `tests/test_loader.py` still asserts the previous SHA, update that assertion to the new one.
4. Commit the pin change in this repository and ship a new harness release.

Do not copy the Hermes tree in while bumping. `hermes update` on a machine still updates only the separate install. The harness install picks up a new pin when it is updated to a release that contains the new `pin/hermes.yaml`.
