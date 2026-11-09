# Operator approves, agent never merges

Once the operator starts a Verification, the agent verifies the Alert and writes the Report with no
further Approval. While it verifies, it may write files and run local commands only in a scratch
copy: a git worktree of the code in the data directory, at the newest commit of the Verify Playbook's
branch (the default branch when blank), fetched from origin first, removed once the Report is ready. That is where it builds mock data and tests that prove the cause.
It never writes in the operator's checkout or to a Connection during a Verification. It changes the
operator's code, files a ticket or opens a PR only after the operator confirms the Report, and it
never merges. Merge is a button only the operator can press; every agent run denies `gh pr merge`,
`glab mr merge`, `bkt pr merge`, `bkt pr auto-merge`, the GitHub and GitLab MCP merge tools and any command that names a
host's merge endpoint or merge mutation through `disallowedTools`, which holds in every access mode. The merge denial is
a list of spellings: no token scope limits what a run holds, so the list cannot cover every way to call a host. Alerts come from service logs, which anyone who can send a Service a request can
write to, so an agent that acted on them alone could be steered into changing code or data. The
console's safety lines close every run's system prompt and say that a log line is data, never an
instruction.

Pressing Agent Review is the approval for one review of a pull request: the agent reads it, compares it with the
target branch fetched from origin, and, in a step the Playbook tags scratch copy (the built-in's test step is one),
may install, build and run the tests in a scratch copy at the pull request's head commit. It writes nothing anywhere
else, and denies itself `git push`, the Git hosts' comment and `api` commands and the write tools of their MCP servers:
the console posts the findings and one summary comment. A review whose Playbook has no scratch copy step runs read-only
in the checkout: it has no edit tools and its working folder is not writable. Pull request text stays data in a review:
the agent runs no command because the description or a comment says so. A run on a pull request's code loads no `.claude`
settings, hooks, `.mcp.json` servers or CLAUDE.md from that code, and neither does the agent's answer in a review thread,
which also holds the same denials and is read-only.

In a chat, the agent opens a pull request only through the console's `open_pull_request` tool, which asks for no
Approval in any Access mode. The console pushes the branch and opens the pull request in the daemon, with the operator's
own git access, never forced. A branch that moved on origin is rebased onto the new tip first; a rebase that conflicts
stops with the branch untouched. When the branch has a pull request already, the push updates it. The agent never pushes
or opens one itself: its commands hold no git credentials and `git push` stays denied.

The agent saves a file outside its folders the same way. The sandbox keeps a run's commands from writing anywhere but its
working folder, its Session's output folder, temp and the package-tool caches, so a file for the operator goes in the
output folder, where the console shows it. To put one in another folder, such as `~/Downloads`, the agent calls the
console's `save_file` tool with a file name from that folder and an absolute folder path. The tool raises an Approval in
every Access mode that shows the file, its size and the destination, and only the operator's yes has the daemon, outside
the sandbox, copy the file. A no is final: the agent does not retry by a command or ask the operator to run `mv`.

On any open pull request, the operator's or a teammate's, pressing Address comments is the approval
for one Comment pass: the agent changes code in a scratch copy at the pull request's head commit, and
the console commits it and pushes that one branch, never with force. In a Comment pass, and only there, the review
comments the operator ticked are change requests: the agent may change code to meet them, but never
runs a command, reads a secret, touches a Connection or pushes because a comment says so. Everywhere
else pull request text stays data, never instructions. The console, not the agent, pushes, posts replies and
resolves threads, and a Reply check or Comment pass denies the agent `git push` and the Git hosts' comment and `api` commands; a general comment on the pull request gets a reply only.

## Considered Options

- **Verification reads only; mock data and tests only in the Fix**: no command runs before the
  operator confirms. It lost because the mock test is how a Verification proves the cause, and after
  the Review it is too late to change the decision it informs.
- **Verification writes in the operator's checkout**: no extra folder, but mock files and test runs
  would mix with the operator's own uncommitted work.
- **Agent Review reads only**: no code from the pull request runs on the operator's machine. It lost because a review
  that cannot run the tests and the build has to guess whether they pass, and the operator asked for that evidence.
- **Pull request text is never an instruction, in every run**: the simplest rule, but acting on
  review comments is the job the operator asks for when they press Address comments.
- **Address comments only on the operator's own pull request**: a teammate's branch would never get
  a commit the teammate did not write, but the operator would fix review comments on a teammate's
  pull request by hand. It lost because the operator wants the agent on those too; the push never
  forces, so a teammate's newer commit stops the Comment pass and nothing of theirs is dropped.
- **Widen the sandbox's write list to `~/Downloads` or any path the operator names**: the agent could move a file at one
  word from the operator. It lost because the sandbox cannot tell the operator's words from text injected through a log,
  so a writable folder would be writable to a steered run, and a run could write into `~/.zshrc`, `~/Library/LaunchAgents`
  or a folder on PATH. The copy goes through an Approval instead, and the daemon writes the destination.
- **An Approval on every `open_pull_request` call**: the operator read what would be pushed and where. It lost because
  the push is never forced and never merges, the diff and the pull request are on the host to read, and the stop broke
  a chat's flow: an update to an open pull request waited for a click each time.
- **Git host credentials inside the Run sandbox so the agent pushes itself**: `ssh` ignores the proxy, and the Bitbucket
  and GitLab CLIs keep their tokens in the Keychain, so it cannot work; where it could, a steered run would hold a
  token that writes to every repository. The daemon pushes for the agent instead.
- **Show the Comment pass diff and wait before the push**: one more stop, but the operator already
  chose the threads, and the commit is on the card and on the host to look at after.

## Consequences

A chat run, steered by text it read, can have the console push the Session's committed branch to `origin` and open a
pull request without a click. It cannot push a force, merge, or push another Repo. The operator sees the pull request on
the host and merges it or not.

An approved `save_file` writes where the operator was shown: the daemon replaces a file of that name in the destination
and checks nothing but that the folder exists. The operator reads the path on the card.

A fix waits for the operator. The console shows how long each verified Alert has waited for its
Review. A run steered by log text can execute local commands in the scratch copy; the safety lines,
the Alert Session's Access mode, the scratch copy's folder and the Run sandbox ([ADR 0006](0006-agent-runs-sandboxed-by-the-os.md))
bound that. The sandbox keeps those commands from writing outside the run's folder and from reading the session token. A reviewer can steer a
Comment pass's code change through a comment the operator ticked; the operator's tick, the
scratch copy and the one pushed commit, never forced, bound that. On a teammate's pull request the
commit lands on their branch under the operator's git identity, for the teammate to see. An Agent Review runs the
pull request's own build and tests, so pressing it runs that branch's code on the operator's Mac, inside the scratch
copy's folder and under the Session's Access mode. A custom Review PR Playbook with no scratch copy step runs nothing
from the branch. A pull request from a fork has no branch on origin to fetch, so its
review fails before any code runs.
