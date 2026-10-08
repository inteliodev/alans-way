# Plaud meeting transcripts

Hayden records meetings and calls with a Plaud device. This folder pulls every recording (AI summary
and full transcript) into the Hermes profiles on the VPS so the agents can use them, and feeds the
**Transcripts** page in the intelio app.

| File | Installed to | What it does |
| --- | --- | --- |
| `plaud-ingest` | `~/.local/bin/plaud-ingest` | Python. Lists recordings with the official `plaud` CLI (read-only) and writes one markdown file per recording to `~/.hermes/profiles/intelio/transcripts/`, plus a copy into each client profile it matches (`prc`, `alignment`, `hhp`, `arlp`, by keyword). Appends `intelio/transcripts/index.jsonl`. State: `~/.plaud-ingest/state.json`. `--backfill` re-lists everything, `--repair` re-parses existing files without calling Plaud. |
| `intelio-transcripts-digest` | `~/.local/bin/intelio-transcripts-digest` | `intelio-transcripts-digest [limit]` prints JSON `{total, items:[{id,title,date,duration,clients,excerpt,actions,file}]}` for the newest recordings. Read-only. |
| `skill/plaud-transcripts/SKILL.md` | `~/.hermes/profiles/<profile>/skills/productivity/plaud-transcripts/` | Tells each agent where transcripts are and how to use them (confidential, propose actions, never edit). |

Schedule (user crontab, flock so runs never overlap):

```
*/30 * * * * flock -n /tmp/plaud-ingest.lock $HOME/.local/bin/plaud-ingest >> $HOME/.plaud-ingest/cron.log 2>&1
```

## Install / upgrade

On the VPS, from the live checkout:

```sh
cd "$(systemctl --user show -p WorkingDirectory --value intelio-pwa.service)"
git pull
bash integrations/plaud/install.sh        # --dry-run to preview
```

The installer copies the two scripts and the skill and adds the cron line only if it is missing.
It does not sign in to Plaud, does not change transcripts already written and does not restart
Hermes; agents pick the skill up in their next session.

## File format

```
---
source: plaud
plaud_id: of_<32 hex>
title: "10-01 Meeting: ..."
date: 2026-10-01
duration: 28m32s
clients: [prc]
ingested: 2026-10-08T20:10:08+00:00
---

# <title>

## Summary
...
## Transcript
...
```

## In the intelio app

`GET /api/transcripts?profile=&client=&q=&limit=&offset=` on the phone server
(`mobile/pwa/transcripts.cjs`) reads these folders read-only, behind the server's usual Tailscale
identity / profile key check. It returns the title, date, duration, client tags, excerpt, summary
and action items (same parsing rules as `intelio-transcripts-digest`), never the transcript body.
The Transcripts page (`desktop/src/intelio/pages.cjs`) lists them with a client filter and search.
