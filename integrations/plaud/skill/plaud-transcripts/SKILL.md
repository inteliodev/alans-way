---
name: plaud-transcripts
description: "Use when Hayden mentions a meeting, call, recording or 'what did we discuss'. Search ingested Plaud transcripts, or query Plaud live."
version: 1.0.0
author: intelio
metadata:
  hermes:
    tags: [plaud, transcripts, meetings, memory, context]
---

# Plaud meeting transcripts

Hayden records meetings and calls with a Plaud device. Every recording (AI summary + full
transcript) is ingested automatically every 30 minutes by `~/.local/bin/plaud-ingest` (cron).

## Where they are
- `$HERMES_HOME/transcripts/*.md`: one file per recording, named `YYYY-MM-DD-title.md`, with
  front matter (`plaud_id`, `date`, `duration`, `clients`) then `## Summary` and `## Transcript`.
- intelio gets every recording; client profiles (prc, alignment, hhp, arlp) get only the ones
  whose title or summary matched that client, so check intelio's folder too
  (`~/.hermes/profiles/intelio/transcripts/`) when a client match might have been missed.
- `~/.hermes/profiles/intelio/transcripts/index.jsonl`: one JSON line per recording (id, title, date, clients, file).

## How to answer questions
1. Narrow by date or keyword first: `grep -il "<keyword>" $HERMES_HOME/transcripts/*.md`, or read index.jsonl.
2. Read the **Summary** section first; open the transcript only for exact quotes or detail.
3. Cite the recording title and date in the answer ("10-07 Client Meeting: Vendor Due Diligence…").
4. Speakers are labelled `Speaker 1/2…` and may be mis-assigned. Say so when attribution matters.

## Live Plaud (anything newer than the last ingest)
The `plaud` CLI is signed in on the VPS (read-only use only):
- `plaud today`, `plaud recent --days 3`, `plaud search "<keyword>"`
- `plaud summary <file_id> --all`, `plaud transcript <file_id> --polished`
- To pull new recordings now: `plaud-ingest`
If it says AUTH_FAILED, tell Hayden the Plaud sign-in expired. Never try to sign in yourself.

## Rules
- Transcripts are confidential client material. Don't share them with another client's agent or
  outside Hayden's accounts.
- Turn action items into proposals for Hayden, not actions: no emails or messages to meeting
  attendees without his approval.
- Never delete or edit recordings or transcript files; re-run `plaud-ingest` to refresh.
