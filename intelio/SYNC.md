# Syncing the Intelio harness contract

This fork does not vendor Hermes. It vendors the intelio-harness checkout that
the desktop app and `python -m intelio_harness` need:

`intelio/vendor/intelio-harness/`

`SOURCE_COMMIT.txt` records the export:

`996267ba526254310a029e3c63825561e470c654`

That tree is the private repo `inteliodev/intelio-harness` at that commit:
`pin/hermes.yaml`, `schema/profile.schema.json`, `brand/` (window title, icon,
Geist woff2), `src/intelio_harness/`, `tests/test_loader.py`,
`examples/example-client/`, `README.md`, and `pyproject.toml`.

The pin is the file from that commit. Upstream is `NousResearch/hermes-agent`
at `5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662`, verified on 2026-10-03. There is
no `sync_status` field.

## What Alan's Way adds

The real loader accepts only `name`, `panels`, `skills`, and `allowed_folders`.
`profile.yaml` in this fork stays inside that schema. Browsing zones, ask-first
safety, and the Hermes profile name (`hermes -p`) live in an optional
`alans-way.yaml` next to it. `python -m intelio_harness` never reads that
sidecar.

`intelio/python/alans_way` calls `intelio_harness.load_profile` and then applies
the sidecar and the `hermes --version` probe. A short `upstream <sha>` token or
`+N.g<sha>` describe suffix is compared to the full pin by prefix. A different
short SHA is `differs` (`installed <sha> vs pin <8 hex>`), not an unverified
probe. It does not reimplement pin or profile parsing. The VPS browser broker loads the same `alans-way.yaml` (or the strict defaults) and calls `desktop/src/intelio/safety.cjs` before an agent navigation. The desktop app runs `python -m alans_way <profile_dir>` with
`PYTHONPATH` set to both `intelio/python` and
`intelio/vendor/intelio-harness/src`. The raw contract check is:

```sh
PYTHONPATH=intelio/vendor/intelio-harness/src python -m intelio_harness intelio/profiles/example --pin intelio/vendor/intelio-harness/pin/hermes.yaml
```

The real loader depends on PyYAML. Brand colors in the desktop are the ones
the harness README states (`#0a0a0a`, `#ffffff`, `#f5f5f5`, `#e5e5e5`, Geist).
The export has no palette file. Window title and icon come from `brand/`.
The desktop copies `brand/fonts/*.woff2` into `desktop/src/fonts/` so the page
can load them.

`examples/example-client/.env.example` is names only (`SAMPLE_API_KEY=`,
`SAMPLE_SIGNING_SECRET=`). The tarball omitted that dotfile; it is restored
here so `tests/test_loader.py` matches the harness README.

## When a newer harness commit is available

1. Replace `intelio/vendor/intelio-harness/` with that commit and write the SHA in `SOURCE_COMMIT.txt`.
2. Keep `alans-way.yaml` out of `profile.yaml` so the real schema still validates.
3. If `brand/fonts/` or `brand/icon.svg` change, copy the fonts into `desktop/src/fonts/` and confirm the icon still embeds a PNG.
4. Re-run `python -m pytest` inside `intelio/vendor/intelio-harness`, `python -m unittest tests.test_intelio_harness`, and `cd desktop && npm run check`.

Do not copy Hermes source into this repo.
