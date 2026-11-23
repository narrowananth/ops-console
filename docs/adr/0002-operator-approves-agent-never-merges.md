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

Pressing Review with agent, Check replies or Address comments is the approval for one PR action Session and for the one
tool call that ends it. The Session is a `repo` Session in a detached worktree at the pull request's head commit, so the
operator can steer the agent in the chat. The agent reads the pull request, compares it with the target branch fetched
from origin, and may install, build and run the tests in that worktree. It never pushes, comments or resolves: it denies
itself `git push`, the Git hosts' comment and `api` commands and the write tools of their MCP servers, and a host write
through `run_integration` is refused. The Session ends in `submit_review`, `submit_reply_verdicts` or
`submit_thread_results`, which asks for no Approval in any Access mode. The console turns the call into the review
comments, the replies and resolves, and, for Address comments only, one commit and a push of `HEAD` to the pull request's
branch, as the operator and never forced, with an Action Log row before each. A branch that moved is rebased onto the new
tip and pushed again; a rebase that conflicts is undone, nothing is posted, and the tool answers with that, so the agent or
the operator settles it in the chat. A run on a pull request's code loads no `.claude` settings, hooks, `.mcp.json`
servers or CLAUDE.md from that code, and has no browser or process tools. Pull request text stays data in all three:
the agent runs no command because the description or a comment says so.

In a chat, the agent opens a pull request only through the console's `open_pull_request` tool, which asks for no
Approval in any Access mode. The console pushes the branch and opens the pull request in the daemon, with the operator's
own git access, never forced. A branch that moved on origin is rebased onto the new tip first; a rebase that conflicts
stops with the branch untouched. When the branch has a pull request already, the push updates it. The agent never pushes
or opens one itself: its commands hold no git credentials and `git push` stays denied.

The agent saves a file outside its folders the same way. The sandbox keeps a run's commands from writing anywhere but its
working folder, its Session's output folder, temp and the package-tool caches, so a file for the operator goes in the
output folder, where the console shows it. To put one in another folder, such as `~/Downloads`, the agent calls the
console's `save_file` tool with a file or folder name from that folder and an absolute folder path. A folder is copied as a new folder of that name, with one Approval that lists its files. The tool raises an Approval
in every Access mode but full that shows the file, its size and the destination, and only the operator's yes has the
daemon, outside the sandbox, copy the file. A Session in full access copies it at once. A no is final: the agent does not retry by a command or ask the operator to run `mv`.

On any open pull request, the operator's or a teammate's, the push is the console's. In an Address comments Session,
and only there, the review comments the operator ticked are change requests: the agent may change code to meet them, but
never runs a command, reads a secret, touches a Connection or pushes because a comment says so. Everywhere else pull
request text stays data, never instructions. A general comment on the pull request gets a reply only.

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
  forces, so a teammate's newer commit that conflicts stops the push and nothing of theirs is dropped.
- **A pull request action as a job in a scratch copy**: Playbook steps, one turn each, then one JSON answer that the
  console posts. It lost because the operator could not steer the agent, ask why it declined a thread or add a request, a
  failed step offered only Retry, and the scratch copy had no installed packages for a build.
- **The agent pushes and posts with its own commands in a PR action Session**: the console could not record what was
  posted or post only what failed, and the agent would hold git and host write access on code it did not write.
- **Widen the sandbox's write list to `~/Downloads` or any path the operator names in a message**: the agent could move a file at one
  word from the operator. It lost because the sandbox cannot tell the operator's words from text injected through a log,
  so a writable folder would be writable to a steered run, and a run could write into `~/.zshrc`, `~/Library/LaunchAgents`
  or a folder on PATH. The copy goes through an Approval instead, and the daemon writes the destination. A Repo the operator
  ticks in the composer's Repos icon is not this option: it is an imported checkout picked by a click, not a path from
  words ([ADR 0006](0006-agent-runs-sandboxed-by-the-os.md)).
- **An Approval on every `open_pull_request` call**: the operator read what would be pushed and where. It lost because
  the push is never forced and never merges, the diff and the pull request are on the host to read, and the stop broke
  a chat's flow: an update to an open pull request waited for a click each time.
- **A cap and a queue on the Sessions one `spawn_sessions` call starts**: past the limit, a Session waits for a place. It
  lost because the Approval already shows the count and the operator decides. Every Spawned Session runs at once, and each
  boots its own Claude Code process with every Connection's MCP server, so a large batch slows the console. That cost
  is accepted.
- **An Approval per Spawned Session**: one click per Repo, each reading one task. It lost because the operator reads the
  whole list once, and a yes per Repo gave back most of the time the batch saves.
- **The console's own tools ask in every Access mode, `full` included** (`save_file`, `spawn_sessions`, `join_repo`,
  `start_process`, `browser_evaluate`, an integration write): the first design. It lost because an operator who chose
  Full access still met a prompt on most turns, and the chip said otherwise. In full access they run at once; the PROD
  write Approval, the merge denial, the Run sandbox and the refusals of sign-in and tokens still hold.
- **Git host credentials inside the Run sandbox so the agent pushes itself**: `ssh` ignores the proxy, and the Bitbucket
  and GitLab CLIs keep their tokens in the Keychain, so it cannot work; where it could, a steered run would hold a
  token that writes to every repository. The daemon pushes for the agent instead.
- **Show the Address comments diff and wait before the push**: one more stop, but the operator already
  chose the threads, and the commit is on the host to look at after. The Session's changes are also there to read in the
  chat before the agent calls the tool.

## Consequences

A chat run, steered by text it read, can have the console push the Session's committed branch to `origin` and open a
pull request without a click. It cannot push a force, merge, or push another Repo. The operator sees the pull request on
the host and merges it or not.

One yes on a `spawn_sessions` list starts a chat run per Repo, and each can push its committed branch and open a pull
request without a click, as any chat run can. The count is new. No run can force a push, merge or push
another Repo, a Spawned Session cannot start others, and the tool is offered only in a chat the operator started, never
in a job that read log or pull request text.

A Session in full access can have the daemon run an integration write as the operator, start a process outside the
sandbox, move into a Repo, start a batch of Sessions or save a file outside its folders with no click. Steered by text it
read, it could do any of these; the operator who set Full access chose that, and a PROD write still asks.

An approved `save_file` writes where the operator was shown: the daemon replaces a file of that name in the destination,
which the card says, refuses a folder whose name is taken, and checks nothing else about the destination but that it
exists and is not closed. `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/Library/LaunchAgents`, `~/Library/LaunchDaemons`,
`~/Library/Keychains` and the console's data folder are refused as destinations, links resolved, in every Access mode
including full. The operator reads the path on the card.

A fix waits for the operator. The console shows how long each verified Alert has waited for its
Review. A run steered by log text can execute local commands in the scratch copy; the safety lines,
the Alert Session's Access mode, the scratch copy's folder and the Run sandbox ([ADR 0006](0006-agent-runs-sandboxed-by-the-os.md))
bound that. The sandbox closes only the Keychain to those commands: they can read the session token and call the console's API, so a steered run can approve its own Approval. The merge denials, the console's own pushing and the PROD write rule still hold. A reviewer can steer a
PR action Session's code change through a comment the operator ticked; the operator's tick, the
worktree and the one pushed commit, never forced, bound that. On a teammate's pull request the
commit lands on their branch under the operator's git identity, for the teammate to see. A PR action Session may run the
pull request's own build and tests, so pressing a button runs that branch's code on the operator's Mac, inside the
worktree's folder, the Run sandbox and under the Session's Access mode. A pull request from a fork has no branch on origin to fetch, so its
review fails before any code runs.
