# Operator approves, agent never merges

Once the operator starts a Verification, the agent verifies the Alert and writes the Report with no
further Approval. It changes code, files a ticket or opens a PR only after the operator confirms the
Report, and it never merges. Merge is a button only the operator
can press; every agent run denies `gh pr merge`, `glab mr merge` and the GitHub and GitLab MCP merge
tools through `disallowedTools`, which holds in every access mode. Alerts come from service logs,
which anyone who can send a Service a request can write to, so an agent that acted on them alone
could be steered into changing code or data.

## Consequences

A fix waits for the operator. The console shows how long each verified Alert has waited for its Review.
