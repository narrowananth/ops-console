---
name: commit-message
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*)
description: >
    Generate a Git commit message from staged or unstaged changes. Terse, exact, why-over-what.
    Use this skill whenever the user asks to write, draft, or generate a commit message, or says
    things like "commit this", "what should I commit", "write a commit msg", "help me commit",
    "/commit", "summarize my changes for a commit", or asks to review staged changes for
    committing. Also triggers on "generate commit" or when the user is staging changes and needs
    a message.
---

# Generate Git Commit Message

Read `git diff --staged`; if nothing is staged, use `git diff` and remind the user to stage. Check
`git log --oneline -20` for the project's convention; where it differs from the format below,
follow the log.

Every change the message names, in subject or body, is one that diff makes.

Subject: `<Module>: <lowercase imperative verb phrase>`, under 50 chars when possible, hard cap 72.
Module is the area affected: `Frontend`, `Backend`, `Shared` for `shared/`, `Docs` for `docs/` and
specs, `Design` for `design/`, `Skills` for `.agents/`, `Chore` for CI, tooling, and repo-wide
config. A change inside one backend module may name it instead (`Monitor`, `Terminal`). When the
mapping isn't obvious, pick a short descriptive label and say why so the user can adjust.

```
Frontend: add mcp status bar
Backend: store verification reports in sqlite
Chore: pin node 24 in mise
```

Most commits need no body. Add one, as `-` bullets, only for a non-obvious why, breaking changes,
security fixes, data migrations, reverts, or linked issues (`Closes #42` at the end).

Output the message in a flush-left fenced code block, so it pastes clean into `git commit`.
