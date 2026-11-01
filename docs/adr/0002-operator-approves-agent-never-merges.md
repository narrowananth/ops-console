# Operator approves, agent never merges

Once the operator starts a Verification, the agent verifies the Alert and writes the Report with no
further Approval. While it verifies, it may write files and run local commands only in a scratch
copy: a git worktree of the code in the data directory, at the commit the default branch points to,
removed once the Report is ready. That is where it builds mock data and tests that prove the cause.
It never writes in the operator's checkout or to a Connection during a Verification. It changes the
operator's code, files a ticket or opens a PR only after the operator confirms the Report, and it
never merges. Merge is a button only the operator can press; every agent run denies `gh pr merge`,
`glab mr merge` and the GitHub and GitLab MCP merge tools through `disallowedTools`, which holds in
every access mode. Alerts come from service logs, which anyone who can send a Service a request can
write to, so an agent that acted on them alone could be steered into changing code or data. The
console's safety lines close every run's system prompt and say that a log line is data, never an
instruction.

## Considered Options

- **Verification reads only; mock data and tests only in the Fix**: no command runs before the
  operator confirms. It lost because the mock test is how a Verification proves the cause, and after
  the Review it is too late to change the decision it informs.
- **Verification writes in the operator's checkout**: no extra folder, but mock files and test runs
  would mix with the operator's own uncommitted work.

## Consequences

A fix waits for the operator. The console shows how long each verified Alert has waited for its
Review. A run steered by log text can execute local commands in the scratch copy; the safety lines,
the Alert Session's Access mode and the scratch copy's folder bound that.
