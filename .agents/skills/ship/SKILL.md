---
name: ship
description: Build one specced change from its local spec in docs/specs/ to an open GitHub PR verified locally, invoking the repo skills in order.
disable-model-invocation: true
---

# Ship

`/ship <slug>`. One change per run, built from `docs/specs/<slug>.md`, which `/spec` wrote. After
a compaction, reread that spec before the next step.

A step that names a skill (`tdd`, `humanizer`, `code-review`, `commit-message`, `pr`, `retro`) runs
it by calling the Skill tool with that name. Every GitHub call goes through `gh`, run from the repo
root.

## Steps

1. **Spec.** Read `docs/specs/<slug>.md`. No such file: list `docs/specs/`, stop and tell the user
   to run `/spec <description>`. Status `draft`: ask the user to confirm it is ready. Done when the
   spec is read and its seams stated.
2. **Branch.** On `main`: `git switch -c <slug>`. On any other branch: stay on it; it is this
   change's branch. Done when `git branch --show-current` prints the branch, and it is not `main`.
3. **Build.** Write the spec's Glossary and ADR sections into `GLOSSARY.md` and `docs/adr/`, then
   `tdd` at the seams in the spec. Wide exploration goes to an `Explore` subagent pointed at the
   spec. Done when the docs hold every Glossary and ADR entry and `pnpm check` passes.
4. **Verify.** Run the change the way the operator does: `docker compose up -d`, `pnpm dev`, then
   drive the changed screen or endpoint. A browser change gets a screenshot; an API or WebSocket
   change gets the `curl` or client output. Use the project's verification skill once
   `create-verification-skill` has made one. Done when the evidence shows the Behavior items on the
   running app. A change with no runtime surface (docs, skills) skips this step: say so.
5. **Prose.** `humanizer` over every changed or new file in `git status --short -- '*.md'`, and
   titles. Done when each listed file has had the pass, or the list is empty.
6. **Review.** `code-review` against `origin/main`, with `docs/specs/<slug>.md` as the spec. Fix the
   findings the user accepts in one pass. Done when both axes report clean or the user waives what
   is left.
7. **Commit.** Set the spec's Status to `shipped`. `commit-message`, then `git push -u origin HEAD`.
   Done when the push succeeds and `git status --short` lists none of this change's files.
8. **PR.** `pr` writes the body to a file outside the repo; the evidence is the red-then-green test
   from step 3 and the run from step 4, and `merge-danger.md` fills Merge Danger. Risk high: show
   the user the gaps and wait for a go. `gh pr create --base main --title "<title>" --body-file
   <file>`. Done when the PR URL is reported. Stop here: the user reviews and merges. Never run
   `gh pr merge`.
9. **Retro.** `retro` on this session. Done when each friction has a fix landed or proposed.

Name any step skipped and why.
