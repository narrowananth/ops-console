# Ops Console

A local console where an operator watches services, reviews what the Claude agent found, and lets
it fix code only after approval.

## Language

### People and agent

**Operator**:
The engineer using the console. The only one who approves fixes and merges PRs.
_Avoid_: user, admin

**Agent**:
Claude running through the Claude Agent SDK on the operator's machine, with the tools and
connections the console grants it.
_Avoid_: bot, AI

**Claude account**:
One Claude subscription signed in on this machine, named by its email, with its own 5-hour and
weekly usage windows. Each is added once. The agent runs under the active one.

**Auto-switch**:
With Smart usage off, moving the active Claude account when its 5-hour usage reaches the
threshold, carrying each Session's conversation over.

**Smart usage**:
Ranking Claude accounts by weekly quota left per day until the weekly reset, so quota that would go
unused is used first, and moving to the top pick on its own while it is on.

**Access mode**:
What the agent may do in a Session without asking: supervised, accept edits, auto or full. A PROD
write asks in every mode.

**Approval**:
The operator's yes or no on one agent action that needs it: a PROD write, or an edit or command in
a mode that asks.

### Monitor

**Service**:
A deployed app the console watches in Datadog. Its code is a local Repo, or a Git URL on its Git host when there
is no local copy.
_Avoid_: app, microservice

**Route**:
One HTTP method and path of a Service (`POST /fb/webhook`), the unit a Scan reports on.
_Avoid_: endpoint, API

**Scan**:
A read of the failing requests in Datadog (logs with an HTTP status code of 400 or more, or the codes the operator
picked) over a time window in every env, for every Service or the ones the operator picked, on the schedule or when the
operator asks. Logs with no `env` tag count as the env `no env`. It groups the logs into Alerts and marks Routes failing or healthy.
_Avoid_: check, sweep

**Fingerprint**:
The identity of an Alert: Service, Route (none for a log with no request), HTTP status code and the error signature with ids, numbers, timestamps and addresses masked. Two failures with the same Fingerprint belong to one Alert.

**Severity**:
An Alert's tier. High: one 10-minute bucket reaches the rapid threshold. Medium: errors per hour reach the failing
threshold with error-level logs. Low: anything else.
_Avoid_: priority, sev2

**Regression**:
A resolved or dismissed Alert that fails again after a healthy Scan. It reopens the same Alert.

**Sample**:
One Datadog log event kept on an Alert, with secret values and request body values redacted.

**Alert**:
One kind of failure in a Service's logs, raised by a Scan, Datadog, Sentry or a Slack message, waiting to be
verified.
_Avoid_: incident, issue

**Verification**:
The agent's attempt to explain an Alert from the code: follow the log through the code end to end, replay the
request locally when it can, cross-check Connections, and write a Report on the issue and its fix.
_Avoid_: investigation, triage

**Report**:
The written outcome of a Verification: steps, the replayed request and its result, root cause and
proposed fix.

**Review**:
The operator's decision on a Report: confirm as a bug or improvement, or dismiss.
_Avoid_: approval

**Ticket**:
The Jira issue the agent creates when the operator confirms a Report while Jira is connected. Its key starts the fix
branch name.

**Fix**:
The work that follows a confirmed Review: ticket (when Jira is connected), branch, code change, tests, push and PR, run by the agent in one Session.

### Workspace

**Repo**:
A local git repository imported into the console, identified by its top folder, where Sessions run.

**Git host**:
The service holding a Repo's remote: GitHub, GitLab or Bitbucket.

**Session**:
One conversation between the operator and the agent. It runs in one Repo on one branch, except a
dev-tools Session and an anonymous Session, which have no Repo. A pull request has its own Session for the agent's
replies, with no composer.
_Avoid_: chat, thread

**Anonymous Session**:
A Session with no imported Repo. It works in a folder of its own in the data directory, and the agent may clone a
repository into it. A Verification or Fix for a Service with no local Repo runs in one that holds a clone of the
Service's Git URL.

**Agent Review**:
The agent's written review of a pull request: findings, a PROD readiness checklist and a verdict,
tied to the commit it read. Each finding is also posted to the Git host as a comment.

### Dev tools

**Connection**:
A database or stream the agent may use, with an Environment and an Access Level.
_Avoid_: datasource, DB

**Access Level**:
What the agent may do on a Connection: none, read, or read and write. Enforced when the server
launches, not only shown.

**PROD**:
The Environment tag on a Connection that reaches production data. Always visible, and every write
asks the operator first.

**MCP Server**:
A server registered in Claude Code that gives the agent tools (Slack, Atlassian, a database). The
console registers it in every Claude account. It exposes tools; it does not sign anyone in. Integrations lists them beside the Connectors; a Connector or Dev tools adds them.

**Probe**:
A short Agent SDK session that reads which MCP Servers connect and which tools they give, then
stops before the model runs.

**Connector**:
An outside service the operator signs in to: Datadog, Jira, GitHub, GitLab, Bitbucket, Slack, Sentry, Shopify. It holds the sign-in and registers the service's MCP Server when it has one. Each is reached through a CLI or an MCP Server and is connected, checked and disconnected in Integrations, the one place a service is connected.

**Setup agent**:
Claude in a terminal in Setup agent that adds Connections, remote MCP Servers and Connectors
from what the operator types. It only adds, and reaches the machine only through the console's setup tools.
_Avoid_: Add with Claude, setup terminal (the terminal is where it runs)

**Result**:
The rows one Connection gave for one Dev tools question, shown as a table under the Connection's name.

**Comparison**:
The agent's match of Results from two or more Connections on one key: one row per field, with the
rows whose values differ marked.

**Action Log**:
The record of every action the agent took outside its own process: query, shell command, message,
PR.
_Avoid_: audit trail, history
