# Syncing the Intelio harness contract

This fork does not vendor Hermes. It vendors only the harness contract the
desktop app and `python -m intelio_harness` need:

- `intelio/vendor/intelio-harness/pin/hermes.yaml`
- `intelio/vendor/intelio-harness/schema/profile.schema.json`
- `intelio/vendor/intelio-harness/brand/` (window title, palette, icon)

## Why this is a vendor tree

`https://github.com/inteliodev/intelio-harness` is private. On 2026-10-05 the
GitHub credential available to this workspace received HTTP 404 for that repo,
so it could not be added as a submodule or imported as a package. The files
above follow the contract described for that repo (profile fields `name`,
`panels`, `skills`, `allowed_folders`; Hermes pin; brand title, icon, and the
palette `#0a0a0a`, `#ffffff`, `#f5f5f5`, `#e5e5e5`, Geist). The Python loader
in `intelio/python/intelio_harness` is a local implementation of
`python -m intelio_harness <profile_dir>` with the same refusal rules. It is
not a copy of the harness source.

The pin commit `ebadb5462e46c168a7eb097895faa647493e0a26` is
`NousResearch/hermes-agent` `main` as verified with the GitHub API on
2026-10-05. `sync_status: stand-in` means it is not Hayden's pin file.

## When the private repo is readable

1. Diff `pin/`, `schema/`, and `brand/` against a pinned harness commit.
2. Replace those three directories with the harness versions.
3. Prefer turning `intelio/vendor/intelio-harness` into a git submodule at that commit, or installing the harness package and pointing `PYTHONPATH` at it, once `python -m intelio_harness` from the real package matches this CLI.
4. If `brand/palette.json` gains or changes keys, update the palette check in `intelio/python/intelio_harness/loader.py` on purpose. The loader currently refuses a palette file that is not exactly the Intelio colors above. The file is named `palette.json` so it is not mistaken for a credential `tokens.json`.
5. Re-run `python -m unittest tests.test_intelio_harness` and `cd desktop && npm run check`.

Do not copy Hermes source into this repo.
