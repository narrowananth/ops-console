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
One Claude subscription signed in on this machine, with its own 5-hour and weekly usage windows.
The agent runs under the active one.

**Auto-switch**:
Moving the active Claude account when its 5-hour usage reaches the threshold, carrying each
Session's conversation over.

**Smart usage**:
Ranking Claude accounts by weekly quota left per day until the weekly reset, so quota that would go
unused is used first.

**Access mode**:
What the agent may do in a Session without asking: supervised, accept edits, auto or full. A PROD
write asks in every mode.

**Approval**:
The operator's yes or no on one agent action that needs it: a PROD write, or an edit or command in
a mode that asks.

### Monitor

**Service**:
A deployed app the console watches in Datadog, linked to one local Repo.
_Avoid_: app, microservice

**Route**:
One HTTP method and path of a Service (`POST /fb/webhook`), the unit a Scan reports on.
_Avoid_: endpoint, API

**Scan**:
A scheduled pass over every Service's Routes in Datadog that marks each one failing or healthy.
_Avoid_: check, sweep

**Alert**:
A failing Route raised by a Scan, Datadog, Sentry or a Slack message, waiting to be verified.
_Avoid_: incident, issue

**Verification**:
The agent's attempt to reproduce an Alert locally: map the log to code, replay the request against
the Repo running locally, and cross-check Connections.
_Avoid_: investigation, triage

**Report**:
The written outcome of a Verification: steps, the replayed request and its result, root cause and
proposed fix.

**Review**:
The operator's decision on a Report: confirm as a bug or improvement, or dismiss.
_Avoid_: approval

### Workspace

**Repo**:
A local git repository imported into the console, where Sessions run.

**Session**:
One conversation between the operator and the agent in one Repo, on one branch.
_Avoid_: chat, thread

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
A server listed by `claude mcp list` that gives the agent tools (Slack, Atlassian, a database).

**Connector**:
An outside service the console itself calls: Datadog, GitHub, Slack, Sentry.

**Action Log**:
The record of every action the agent took outside its own process: query, shell command, message,
PR.
_Avoid_: audit trail, history
