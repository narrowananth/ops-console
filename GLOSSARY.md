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

**Sign-in by link**:
Adding a Claude account without a browser tab on this Mac: the console shows Anthropic's sign-in
link, anyone opens it in any browser, and the one-time code Anthropic shows comes back to the
console. The other way is signing in in this browser.
_Avoid_: remote login, shared login, callback URL

**Claude account hub**:
What signs the agent in to Claude: the console's own Claude accounts, or CLIProxy. With CLIProxy,
runs send CLIProxy's API key to a CLIProxy server on this Mac, and CLIProxy picks the account and
tracks the quota; Auto-switch and Smart usage pause.
_Avoid_: proxy mode, account manager

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

**Run sandbox**:
The operating-system limit on an agent run's commands: writes only in the run's working folder, temp and package-tool caches, no reads of
the console's data folder or the operator's cloud and login credentials. Package-tool caches under the home folder stay writable so a repo's commit hooks and builds run. It applies in every Access mode, and a run
fails when the sandbox is unavailable.

**Network allowlist**:
The hosts an agent run's commands may reach, built when the run starts from the built-in hosts, the hosts of the
Repos' remotes and the operator's own domains. Any other host is refused.

### Playbooks

**Playbook**:
The rules and ordered steps the agent follows when a Trigger starts it, written by the operator, the Skills it holds,
the branches Verify and Fix read the code from, and whether a Fix makes a Ticket. Each Trigger holds one; one Playbook
may be held by several. Each Trigger without one runs its built-in.
_Avoid_: rule, pipeline, workflow

**Trigger**:
A place in a tab that starts the agent: Verify and Fix in Monitor, Review PR, Check reply, Address comments, Reply in
thread and Session message in Workspace.
_Avoid_: action (the Action Log means each command the agent runs)

**Job**:
A Trigger's run that goes through its Playbook steps and then the console's closing turn: a Verification, Fix, Agent
Review, Reply check or Comment pass. Reply in thread and Session message are chats, not jobs.

**Skill**:
A named instruction document the operator keeps in the console and attaches to Playbooks: a name, a description of when to
use it, and Markdown instructions. The agent sees the name and description of each Skill its Playbook holds and loads the
instructions when a step needs them. Text only, no scripts or files. Not the skills in `.agents/skills/`, which are for
this repo's developers.
_Avoid_: plugin, add-on, prompt

**Playbook step**:
One titled instruction in a Playbook, run as its own agent turn, ending done, skipped or failed.

**Step block**:
A ready-made Playbook step the operator drags into a Playbook and then edits.

**Scratch copy**:
A throwaway copy of a Repo's code, at the newest commit of the Playbook's branch for a Verification, fetched from
origin, or at a pull request's head commit for a
Reply check, a Comment pass or an Agent Review, where the agent may write files and run local commands. A Playbook step that needs one carries the tag "scratch copy".

### Monitor

**Service**:
A deployed app the console watches in Datadog, one per Datadog service name and env. Its code is a local Repo, or a
Git URL on its Git host when there is no local copy.
_Avoid_: app, microservice

**Check interval**:
How often the schedule scans a Service and how far back that Scan reads: 6, 12 or 24 hours, in slots from the
Datadog Connector's daily scan time.

**Route**:
One HTTP method and path of a Service (`POST /fb/webhook`), the unit a Scan reports on.
_Avoid_: endpoint, API

**Scan**:
A read of the failing requests in Datadog (logs with an HTTP status code of 400 or more, or the codes the operator
picked) over a time window in every env, for every Service or the ones the operator ticked, on the schedule or when the
operator asks. A Scan of one Service reads its own env. Logs with no `env` tag count as the env `no env`. It groups the
logs into Alerts and marks Routes healthy, failing or rapid.
_Avoid_: check, sweep

**Fingerprint**:
The identity of an Alert: Service, Route (none for a log with no request), HTTP status code and the error signature with ids, numbers, timestamps and addresses masked. Two failures with the same Fingerprint belong to one Alert.

**Severity**:
An Alert's tier. High: one 10-minute bucket reaches the rapid threshold. Medium: errors per hour reach the failing
threshold, and the logs are at error level or the status code is 500 or more. Low: anything else.
_Avoid_: priority, sev2

**Regression**:
A resolved or dismissed Alert that fails again after a healthy Scan. It reopens the same Alert.

**Freshness**:
How long since the last finished Scan that covered an Alert's Service and status code. It warns past two Check
intervals.
_Avoid_: staleness, age

**Recheck**:
One read of Datadog for an Alert's query over the last hour, made when a Verification or a Fix starts, with no model
turn. It says whether the failure is still happening.

**Prod parity**:
The section of a Report or pull request description that says how the run differed from prod: code version, data,
configuration and environment, dependencies.

**Sample**:
One Datadog log event kept on an Alert, with secret values and request body values redacted.

**Alert**:
One kind of failure in a Service's logs, raised by a Scan. It moves from open through verifying, verified, fixing and
PR open to resolved, or is dismissed.
_Avoid_: incident, issue

**Verification**:
The agent's attempt to explain an Alert from the code, in a scratch copy of it: follow the log through the code end to
end, replay the request and test with mock data locally when it can, cross-check Connections, and write a Report on the
issue and its fix.
_Avoid_: investigation, triage

**Report**:
The written outcome of a Verification: steps, the replayed request and its result, root cause and
proposed fix.

**Review**:
The operator's decision on a Report: confirm as a bug or improvement, or dismiss. A dismissal can be undone.
_Avoid_: approval

**Ticket**:
The Jira issue the agent creates when the operator confirms a Report, while Jira is connected and the Fix Playbook
asks for one (the built-in does not). Its key starts the fix branch name. When the ticket cannot be made, the Fix goes
on without one.

**Fix**:
The work that follows a confirmed Review: ticket (when its Playbook asks and Jira is connected), branch, the steps of
its Playbook (code change, mocked tests, the full suite and a diff review by default), the agent's PR description, then the console's push and PR opening, in the Alert's Session. A merged PR resolves the Alert; a PR closed unmerged, or the operator's Cancel, abandons the Fix.

### Workspace

**Repo**:
A local git repository imported into the console, identified by its top folder, where Sessions run.

**Git host**:
The service holding a Repo's remote: GitHub, GitLab or Bitbucket.

**Pull request opening**:
The console's push of a Session's branch to `origin` and its call to the Git host to open the pull request, run in the daemon as the operator. The agent writes the title and description; it never pushes or opens. The operator's click starts it in a Session, as does the operator's Approval of the agent's request, and a confirmed Fix starts it by itself.

**Session**:
One conversation between the operator and the agent, named for its first task. It runs in one Repo on one branch, except a
dev-tools Session and an anonymous Session, which have no Repo. A pull request has its own Session for the agent's
replies, with no composer, and an Alert has one for its Verification and Fix.
_Avoid_: chat, thread

**Running tray**:
The sidebar list of agent runs: the ones going, each with the subagents it started, and the ones that ended unfinished
(stopped, paused, out of usage, signed out, interrupted by a restart). An unfinished run stays until the operator
dismisses it. Each entry shows how long the run took and controls to pause, stop, play or retry it.
_Avoid_: notification panel, running tasks

**Agent runs page**:
The sidebar page for every agent run: whether to look at it (its health), what it does, where its time went, and why it
is slow or ended. It has the controls of the Running tray, plus the queued message and desktop alerts.
_Avoid_: dashboard, monitor

**Run health**:
What the Agent runs page says about a run: on track, slow, needs you, failed or stopped. The daemon reads it from the
run's steps, its Approvals and its outcome.

**Alert Session**:
The Session an Alert's first Verification makes, linked to the Alert. Every later Verification and Fix stage runs in
it: a Session in the Service's Repo, on the Repo's default branch, or an Anonymous Session holding a clone.

**Session diff**:
What a Session's own branch changes against the commit it forked from, shown beside the conversation and followed as
the agent moves to another branch.

**Anonymous Session**:
A Session with no imported Repo. It works in a folder of its own in the data directory, and the agent may clone a
repository into it. A Verification or Fix for a Service with no local Repo runs in one that holds a clone of the
Service's Git URL.

**Agent Review**:
The agent's written review of a pull request: a verdict (approve, request changes or comment), findings rated
critical, high, medium, low or info, a PROD readiness checklist and a full report, tied to the commit it read and the
target branch commit it compared with. Each finding is posted to the Git host on its line, and the verdict and report
as one comment. A newer commit makes it stale. The operator may add a **Review note** when starting it: free text the
agent reads with the pull request, such as where to look or a related pull request to read first. The note narrows the
review; the Playbook's checks stay.

**Reply check**:
The agent's check of a pull request thread: whether the code at the head commit does what the thread asked, given
as fixed, partly fixed or not fixed in a reply. On fixed the thread is resolved. Check replies runs one over every
unresolved thread that has a reply, as a Comment pass of kind check that changes, commits and pushes nothing.

**Comment pass**:
The agent's work on the review threads the operator ticked on a pull request, theirs or a teammate's (Address comments): one commit pushed
to its branch, a reply in each thread, and each done thread on a line or a file resolved.
_Avoid_: fix (a Fix follows an Alert's Review)

### Dev tools

**Connection**:
A database or stream the agent may use, with an Environment and an Access Level.
_Avoid_: datasource, DB

**Access Level**:
What the agent may do on a Connection: none, read, or read and write. Enforced when the server
launches, not only shown.

**PROD**:
The Environment tag on a Connection that reaches production data. Always visible, and the agent only
reads it: a PROD Connection is never given write access.

**MCP Server**:
A server registered in Claude Code that gives the agent tools (Slack, Atlassian, a database). The
console registers it in every Claude account. It exposes tools; it does not sign anyone in. Integrations lists them beside the Connectors; a Connector or Dev tools adds them.

**Probe**:
A short Agent SDK session that reads which MCP Servers connect and which tools they give, then
stops before the model runs.

**Connector**:
An outside service the operator signs in to: Datadog, Jira, GitHub, GitLab, Bitbucket, Slack, Sentry, Shopify, slashdocs. It holds the sign-in and registers the service's MCP Server when it has one. Each is reached through a CLI or an MCP Server and is connected, checked and disconnected in Integrations, the one place a service is connected.

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
The record of every action the agent took outside its own process: query, shell command, git command,
message, ticket, PR.
_Avoid_: audit trail, history

### Console

**Start at login**:
launchd starting the installed console when the operator logs in, and again if it stops. macOS lists it as Ops
Console under App Background Activity. A dev build never starts at login.

**Keychain wait**:
A Keychain call the Mac has not answered, usually because it waits for the login password. The console shows it after
10 seconds and fails the call after 60.

**Keychain handover**:
The first start of a new version taking the Keychain items from the previous version's app, so macOS does not ask for the
login password once per item.

**Handover refusal**:
The console declining a Keychain handover because the previous app failed its check. It shows on the Permissions page
until the next start.

**Tip**:
The words a control, status or label shows on hover or keyboard focus: what it means, what pressing it makes the
agent do, or why it is off.
_Avoid_: tooltip

**Update**:
Installing a newer release of the console over the running one, which then restarts on it. With **auto-update**
on, the console installs one by itself once no agent run is going.
_Avoid_: upgrade

**Remembered view**:
What the operator picked, ticked, typed or opened on a page, kept until they change it, through page switches,
reloads and reopening the console.
_Avoid_: saved state, preferences
