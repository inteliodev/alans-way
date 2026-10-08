---
name: cursor-agent
description: Use when the task allows handing work to Cursor. Run Cursor's cursor-agent CLI non-interactively in the task worktree.
version: 1.0.0
metadata:
  hermes:
    tags: [coding-agent, cursor, delegation]
---

# Cursor agent (cursor-agent CLI)

Cursor's headless coding agent, installed user-level at `~/.local/bin/cursor-agent`.
Only use it when the task brief says Hermes may hand work to **Cursor**.

## Check sign-in first

```bash
cursor-agent status        # "Not logged in" => stop, tell Hayden to run:
                           # NO_OPEN_BROWSER=1 ~/.local/bin/cursor-agent login   (on the VPS)
```

Never try to log in yourself and never pass API keys on the command line.

## Run a sub-task

Run from the task worktree (the current directory). Give it a focused, self-contained brief.

```bash
cursor-agent -p --trust --force --output-format text --workspace "$PWD" \
  "Fix the failing test in src/foo.test.ts. Do not push. Report what you changed."
```

- `-p` = non-interactive print mode; `--force` lets it run shell commands; `--trust` trusts the worktree.
- `--output-format stream-json` gives JSONL events if you need to follow progress.
- Resume a chat: `cursor-agent -p --resume <chatId> "follow-up"` (chat id is in the stream-json `session_id`).
- Pick a model with `--model <name>` (`cursor-agent models` lists what the account has).

## Rules

- Cursor works in the same worktree; review its diff (`git diff`) before you report.
- Same push policy as you: feature branches and PRs are fine, never push or merge to the default branch.
- If it fails or is not signed in, do the work yourself and mention it in your report.
