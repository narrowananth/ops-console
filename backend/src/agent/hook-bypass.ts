/** The text of `command` without its quoted strings, so a flag named inside a commit message is not read as a flag. */
const unquoted = (command: string) => command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');

const GIT = /(?:^|[\s;&|(])git(?=\s)/;
const SKIPS = [
  /--no-verify\b/,
  // `-n` is `--no-verify` on `git commit` only.
  /\bcommit\b[^;&|\n]*\s-[A-Za-z]*n[A-Za-z]*(?=\s|$)/,
  /\bcore\.hooksPath[= ]+(?:\/dev\/null|""|'')?(?=\s|$)/,
];
const ENV_SKIPS = /(?:^|[\s;&|(])(?:HUSKY=0|HUSKY_SKIP_HOOKS=\S|LEFTHOOK=0|SKIP=\S)/;

/**
 * Whether a shell command skips a repo's commit hooks: `--no-verify`, `git commit -n`, hooks pointed at nothing, or the
 * environment switches husky, lefthook and pre-commit read. The agent runs the hooks and fixes what they report.
 */
export function skipsCommitHooks(command: string): boolean {
  const bare = unquoted(command);
  return ENV_SKIPS.test(bare) || (GIT.test(bare) && SKIPS.some((pattern) => pattern.test(bare)));
}

export const HOOK_BYPASS_REASON =
  "This skips the repo's commit hooks. Run them and fix what they report: use the repo's formatter or lint fixer, install its dependencies, correct the code, then commit again.";
