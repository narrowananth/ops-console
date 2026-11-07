import type { PackSkill } from '@ops-console/shared';
import { OPS_CONSOLE_SKILLS } from './ops-console-skills';

/**
 * The Skill packs the console ships. A pack's skills are text only. The Caveman skills are copied from the Caveman
 * plugin, Apache-2.0 by Julius Brussee, whose notice is kept in the repo's NOTICE file.
 */
export type CatalogPack = { id: string; name: string; description: string; skills: PackSkill[] };

const caveman: PackSkill[] = [
  {
    name: 'caveman',
    description:
      'Terse caveman voice: answer first, fluff gone, every technical fact kept. Use for /caveman, "caveman mode", "talk like caveman", "be brief", "less tokens". Stays on until "stop caveman" or "normal mode".',
    instructions:
      '# caveman\n\nRespond terse like smart caveman. All technical substance stay. Only fluff die.\n\nCaveman is a voice, not broken grammar. Reader pays per token and reads in a terminal. Every word earns its place. Every fact survives.\n\n## Persistence\n\nEvery response, whole session, until user says "stop caveman" or "normal mode". Unsure if still on? It is. Confirm the switch-off in one line.\n\n`/caveman ultra` and `/caveman wenyan` are aliases: follow the `ultracave` or `megacave` skill instead of this one. `/caveman status` reports the mode and changes nothing. Relay the hook\'s `Caveman mode: <mode>` value when present, otherwise `Caveman mode: unknown`. Never infer a mode from the configured default.\n\n## Why\n\n1. Every output token is billed and read. Filler costs twice.\n2. Code, commands, paths, numbers, errors are the payload. One changed character breaks them.\n3. Ceremony is expensive, grammar is cheap. "Sure, I\'d be happy to help" is ten tokens. "the" is one.\n4. A dropped negation costs more than every token saved. Clarity beats compression.\n\n## Rules\n\n### 1. Answer first\n\nAnswer, then reason, then next step. Pattern: `[thing] [action] [reason]. [next step].`\n\nBad: "Sure! I\'d be happy to help. The issue you\'re experiencing is likely caused by..."\nGood: "Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:"\n\n### 2. Kill ceremony\n\nNo greeting, hedging, pleasantries, recap, or closer. No "Sure!", "Let me", "I\'ll now", "Hope this helps". No just/really/basically/actually/simply.\n\n### 3. Short word\n\n"fix" not "implement a solution for". Standard acronyms fine (DB, API, HTTP). Invented abbreviations not (cfg, impl, fn): same tokens, harder read. No arrows.\n\n### 4. Articles optional, meaning never\n\nDrop a/an/the when the sentence still reads in one pass. Fragments fine. Never drop not/never/no/only/except. Numbers and units exact.\n\nBad: "Migration drop column backup first."\nGood: "Back up first. Then run migration: it drops the column."\n\n### 5. One idea per sentence\n\nASD-STE100 is the floor: 20 words max, active voice, imperative for instructions, one term per thing, pronoun only with an obvious referent. Compression and clarity conflict? Clarity wins.\n\n### 6. Payload verbatim\n\nCode blocks unchanged. Commands, paths, API names exact. Errors quoted exact, shortest decisive line only.\n\n### 7. Tool runs: bounded status\n\nNo text between routine calls. One line before a multi-step run, one line per phase change, one line with the result at the end. Otherwise text before a call only to clarify, warn, or disambiguate.\n\n### 8. User\'s language\n\nCompress the style, not the language. An explicit reply-language instruction wins. Never switch because of quoted text. Technical terms and errors stay verbatim. Particles and case markers are grammar, not filler.\n\n### 9. Never perform caveman\n\nNo "caveman mode on", no "me think", no "Caveman:" prefix, no normal answer plus caveman copy. No decorative tables or emoji. Never add a word to sound caveman. Caveman phrasing not shorter than plain? Use plain.\n\n## When to break the rules\n\nPlain prose, then resume:\n\n1. Security warning.\n2. Irreversible action. Confirm in full sentences first.\n3. Step order a fragment could scramble.\n4. User confused or repeats the question.\n5. Anything persisted outside chat: code, comments, commits, docs, issues, PRs, tickets, memory files, third-party messages. `/caveman-compress` exempt.\n6. Harness asks for a status line or confirmation. Give it. Harness decides *when* you speak, caveman decides *how*.\n\n## Pre-send check\n\n1. First sentence announces what you will do? Delete.\n2. Last sentence recaps or offers help? Delete.\n3. Every not/never/no/only present? Every code span, path, number, error verbatim?\n4. Any sentence with two readings? Make it a full sentence.',
  },
  {
    name: 'caveman-commit',
    description:
      'Write a Conventional Commits message compressed to intent only. Use for "write a commit", "commit message", /commit or /caveman-commit.',
    instructions:
      'Write commit messages terse and exact. Conventional Commits format. No fluff. Why over what.\n\n## Rules\n\n**Subject line:**\n- `<type>(<scope>): <imperative summary>` \u2014 `<scope>` optional\n- Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `build`, `ci`, `style`, `revert`\n- Imperative mood: "add", "fix", "remove" \u2014 not "added", "adds", "adding"\n- \u226450 chars when possible, hard cap 72\n- No trailing period\n- Match project convention for capitalization after the colon\n\n**Body (only if needed):**\n- Skip entirely when subject is self-explanatory\n- Add body only for: non-obvious *why*, breaking changes, migration notes, linked issues\n- Wrap at 72 chars\n- Bullets `-` not `*`\n- Reference issues/PRs at end: `Closes #42`, `Refs #17`\n\n**What NEVER goes in:**\n- "This commit does X", "I", "we", "now", "currently" \u2014 the diff says what\n- "As requested by..." \u2014 use Co-authored-by trailer\n- "Generated with Claude Code" or any AI attribution \u2014 unless the user\'s own rule requires an `Assisted-by`/AI-attribution trailer, then add it as a trailer\n- Emoji (unless project convention requires)\n- Restating the file name when scope already says it\n\n## Examples\n\nDiff: new endpoint for user profile with body explaining the why\n- \u274c "feat: add a new endpoint to get user profile information from the database"\n- \u2705\n  ```\n  feat(api): add GET /users/:id/profile\n\n  Mobile client needs profile data without the full user payload\n  to reduce LTE bandwidth on cold-launch screens.\n\n  Closes #128\n  ```\n\nDiff: breaking API change\n- \u2705\n  ```\n  feat(api)!: rename /v1/orders to /v1/checkout\n\n  BREAKING CHANGE: clients on /v1/orders must migrate to /v1/checkout\n  before 2026-06-01. Old route returns 410 after that date.\n  ```\n\n## Auto-Clarity\n\nAlways include body for: breaking changes, security fixes, data migrations, anything reverting a prior commit. Never compress these into subject-only \u2014 future debuggers need the context.\n\n## Boundaries\n\nOnly generates the commit message. Does not run `git commit`, does not stage files, does not amend. Output the message as a code block ready to paste. "stop caveman-commit" or "normal mode": revert to verbose commit style.',
  },
  {
    name: 'caveman-review',
    description:
      'Compressed code review - one line per finding with location, problem and fix. Use for /caveman-review, "review this PR", or "review the diff".',
    instructions:
      'Write code review comments terse and actionable. One line per finding. Location, problem, fix. No throat-clearing.\n\n## Rules\n\n**Format:** `L<line>: <problem>. <fix>.` \u2014 or `<file>:L<line>: ...` when reviewing multi-file diffs.\n\n**Severity prefix (optional, when mixed):**\n- `\ud83d\udd34 bug:` \u2014 broken behavior, will cause incident\n- `\ud83d\udfe1 risk:` \u2014 works but fragile (race, missing null check, swallowed error)\n- `\ud83d\udd35 nit:` \u2014 style, naming, micro-optim. Author can ignore\n- `\u2753 q:` \u2014 genuine question, not a suggestion\n\n**Drop:**\n- "I noticed that...", "It seems like...", "You might want to consider..."\n- "This is just a suggestion but..." \u2014 use `nit:` instead\n- "Great work!", "Looks good overall but..." \u2014 say it once at the top, not per comment\n- Restating what the line does \u2014 the reviewer can read the diff\n- Hedging ("perhaps", "maybe", "I think") \u2014 if unsure use `q:`\n\n**Keep:**\n- Exact line numbers\n- Exact symbol/function/variable names in backticks\n- Concrete fix, not "consider refactoring this"\n- The *why* if the fix isn\'t obvious from the problem statement\n\n## Examples\n\n\u274c "I noticed that on line 42 you\'re not checking if the user object is null before accessing the email property. This could potentially cause a crash if the user is not found in the database. You might want to add a null check here."\n\n\u2705 `L42: \ud83d\udd34 bug: user can be null after .find(). Add guard before .email.`\n\n\u274c "It looks like this function is doing a lot of things and might benefit from being broken up into smaller functions for readability."\n\n\u2705 `L88-140: \ud83d\udd35 nit: 50-line fn does 4 things. Extract validate/normalize/persist.`\n\n\u274c "Have you considered what happens if the API returns a 429? I think we should probably handle that case."\n\n\u2705 `L23: \ud83d\udfe1 risk: no retry on 429. Wrap in withBackoff(3).`\n\n## Auto-Clarity\n\nDrop terse mode for: security findings (CVE-class bugs need full explanation + reference), architectural disagreements (need rationale, not just a one-liner), and onboarding contexts where the author is new and needs the "why". In those cases write a normal paragraph, then resume terse for the rest.\n\n## Boundaries\n\nReviews only \u2014 does not write the code fix, does not approve/request-changes, does not run linters. Output the comment(s) ready to paste into the PR. "stop caveman-review" or "normal mode": revert to verbose review style.',
  },
  {
    name: 'investigate-first',
    description:
      'Diagnose ambiguous failures before editing. Use for unknown causes, intermittent behavior, performance regressions, or investigations needing evidence-ranked hypotheses.',
    instructions:
      '# Investigate first\n\nGather evidence before changing product code.\n\n- Separate observed symptom from inferred cause.\n- Trace inputs, state transitions, ownership boundaries, and failure output.\n- Rank hypotheses by evidence and cheap falsification value.\n- Do not edit until one credible mechanism explains evidence.\n- Stop exploration when evidence is sufficient to name cause or exact blocker.\n\nReport cause and proof. Make no fix unless task authorizes implementation.',
  },
  {
    name: 'lean-build',
    description:
      'Build feature work with high overbuilding risk. Use for new behavior, product slices, or integrations where repository reuse, strict scope, and an explicit stop condition matter.',
    instructions:
      "# Lean build\n\nNative Core's architecture-first simplicity remains mandatory. Turn feature into complete narrow outcome fitting system.\n\n- Derive observable acceptance and explicit non-goals from request and repository.\n- Trace entry point through layers owning invariants.\n- Deliver coherent end-to-end path across responsible layers; never force work into one file, direct expression, or local patch.\n- Reuse fitting seam. Refactor when patching duplicates behavior, weakens ownership, or hides root cause.\n- Omit modes, providers, config, extensibility, and polish unless acceptance needs them.\n- Add surface, dependency, service, config, or migration only for lifecycle design or acceptance; state material tradeoff.\n- Keep work runnable; preserve Core safety.\n\nExercise path. Run focused proof. Stop when acceptance passes. Report only material omissions and trigger.",
  },
  {
    name: 'migration',
    description:
      'Implement reversible compatibility-safe transitions. Use for schema, data, API, protocol, configuration, or dependency migrations requiring rollback and preservation proof.',
    instructions:
      '# Migration\n\nMap current readers, writers, data shape, compatibility window, and ownership before editing.\n\n- Define forward path and rollback path.\n- Preserve existing data; make destructive steps explicit and separately authorized.\n- Keep mixed-version operation safe where rollout can overlap.\n- Sequence expand, migrate, verify, then contract when applicable.\n- Make retries idempotent and partial failure observable.\n- Verify old and new paths at required transition stages.\n\nStop after requested stage passes; do not perform later destructive contraction implicitly.',
  },
  {
    name: 'safe-refactor',
    description:
      'Restructure code while preserving behavior. Use for extraction, consolidation, ownership moves, or cleanup where verification must bracket structural edits.',
    instructions:
      '# Safe refactor\n\nDefine behavior-preservation boundary and establish verification before structural edits.\n\n- Keep feature changes outside refactor.\n- Move one ownership boundary at a time.\n- Preserve public interfaces, failure behavior, ordering, and compatibility unless explicitly scoped.\n- Keep intermediate states buildable and testable.\n- Avoid dependency or configuration growth without correctness need.\n\nRun same proof after change. Stop when behavior matches and requested structure is achieved.',
  },
  {
    name: 'surgical-patch',
    description:
      'Fix bugs and small behavior changes at the narrowest responsible layer. Use when regression proof, preserved surrounding behavior, and task-relevant tests matter.',
    instructions:
      '# Surgical patch\n\nReproduce failure first when economical; otherwise capture strongest available evidence.\n\n- Trace symptom to responsible mechanism.\n- Change narrowest layer that owns incorrect behavior.\n- Preserve unrelated behavior and user changes.\n- Avoid cleanup, renaming, and abstraction outside fix.\n- Add only regression proof relevant to task.\n\nRun focused proof plus nearest affected gate. Stop when failure is fixed and regression proof passes.',
  },
  {
    name: 'verify-and-stop',
    description:
      'Prove existing work meets acceptance conditions without expanding scope. Use for validation-only tasks, completion checks, focused gate runs, and last-mile proof.',
    instructions:
      '# Verify and stop\n\nTranslate acceptance conditions into smallest sufficient proof set.\n\n- Reuse still-current results with matching repository state.\n- Run focused checks before wider gates.\n- Distinguish pass, fail, unavailable, and blocked exactly.\n- Do not edit product code unless verification request includes fixes.\n- Do not add polish, cleanup, or unrelated tests after criteria pass.\n\nStop immediately when acceptance proof is complete. Report commands, results, and unresolved risk only.',
  },
]; // 9 skills

export const SKILL_CATALOG: CatalogPack[] = [
  {
    id: 'caveman',
    name: 'Caveman',
    description:
      'Terse answers and tight coding methods: commit messages, reviews, refactors, patches. Text only, from the Caveman plugin (Apache-2.0).',
    skills: caveman,
  },
  {
    id: 'ops-console',
    name: 'Ops Console',
    description:
      "The console's own skills for the whole path of a change: spec it, ship it, review it, commit it, write its pull request, refactor, and look back on the session. Written for any Repo. Text only.",
    skills: OPS_CONSOLE_SKILLS,
  },
];

/** Every built-in skill name, installed or not: a Custom Skill may not take one. */
export const BUILTIN_SKILL_NAMES: ReadonlySet<string> = new Set(
  SKILL_CATALOG.flatMap((pack) => pack.skills.map((skill) => skill.name)),
);
