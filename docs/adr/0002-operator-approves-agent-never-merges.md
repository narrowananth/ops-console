# Operator approves, agent never merges

The agent verifies and reports on its own, but it changes code, files a ticket or opens a PR only
after the operator confirms the Report, and it never merges. Merge is a button only the operator
can press; the agent's tool list holds no merge and `.claude/settings.json` denies `gh pr merge`.
Alerts arrive from Slack and logs, which anyone can write to, so an agent that acted on them alone
could be steered into changing code or data.

## Consequences

A fix waits for the operator. The console shows how long each Report has waited.
