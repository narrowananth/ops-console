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

Pressing Review with agent, Check replies, Address comments or a thread's own Check reply or Address comment button is
the approval for one Round and for the one tool call that ends it. A pull request has one PR Session, a `repo` Session in
a detached worktree at the pull request's head commit, so the operator can steer the agent in the chat. The first press
makes it. Every later press starts a new Round in it: the console fetches the branch, moves the worktree to the pull
request's current head commit with any uncommitted changes carried along, and posts the Round's opening prompt, so the
agent keeps what it learned. A press while the Session's turn is running is refused. A press on an idle Session drops a
Round that never submitted. The agent reads the pull request, compares it with the target branch fetched from origin, and
may install, build and run the tests in that worktree. It never pushes, comments or resolves: it denies itself
`git push`, the Git hosts' comment and `api` commands and the write tools of their MCP servers, and a host write through
`run_integration` is refused. A Round ends in `submit_review`, `submit_reply_verdicts` or `submit_thread_results`, which
asks for no Approval in any Access mode. All three are offered in the PR Session, and the console takes a call only for
the current Round: a call of another Round's tool posts nothing, and a second call in a Round answers "Already
submitted". The console turns the call into the review comments, the replies and resolves, and, for Address comments
only, one commit and a push of `HEAD` to the pull request's branch, as the operator and never forced, with an Action Log
row before each. A branch that moved is rebased onto the new tip and pushed again; a rebase that conflicts is undone,
nothing is posted, and the tool answers with that, so the agent or the operator settles it in the chat. A run on a pull
request's code loads no `.claude` settings, hooks, `.mcp.json` servers or CLAUDE.md from that code, and has no browser or
process tools. Pull request text stays data in every Round but Address comments: the agent runs no command because the
description or a comment says so, and a chat turn between Rounds is data too.

In a chat, the agent opens a pull request only through the console's `open_pull_request` tool, which asks for no
Approval in any Access mode. The console pushes the branch and opens the pull request in the daemon, with the operator's
own git access, never forced. A branch that moved on origin is rebased onto the new tip first; a rebase that conflicts
stops with the branch untouched. When the branch has a pull request already, the push updates it. The agent never pushes
or opens one itself: it is told so, and `git push` is denied in the PR Session and a Verification.

The agent also changes services outside this Mac, Notion, Shortcut and Render, only by asking. Their tools are sorted into Tool
classes: a read runs, a write raises an Approval in every Access mode but full, and a delete, or any tool no class
places, raises one in every mode, full included. Notion's and Render's classes are lists of names; Shortcut's server publishes none,
so a rule on the words of the tool name places them. The Approval is a `command` one with no PROD tag, and an Action Log row, holding the
tool and a capped, redacted summary of its main inputs, is written before the call. A no is final, as for `save_file`.
Jobs and a pull request's Session reach no Notion, Shortcut or Render server, so text from logs or a pull request starts no call there. Figma
is read only instead: every tool off its Read list is refused with no Approval.

A file for the operator goes in the Session's output folder, where the console shows it. To put a copy in another
folder, such as `~/Downloads`, the agent calls the console's `save_file` tool with a file or folder name from that
folder and an absolute folder path. A folder is copied as a new folder of that name, with one Approval that lists its
files. The tool raises an Approval in every Access mode but full that shows the file, its size and the destination, and
only the operator's yes has the daemon copy the file. The Approval covers the tool only: a run's own commands write
anywhere the operator can ([ADR 0006](0006-agent-runs-sandboxed-by-the-os.md)). A Session in full access copies it at once. A no is final: the agent does not retry by a command or ask the operator to run `mv`.

In an Anonymous Session the operator started, the agent also has the console's setup tools: it tests, saves and
registers Connections, MCP Servers and Connectors, reads files, folders, pages and other apps' Keychain items, and asks
for a secret. Each tool that tests with a secret, saves, registers, starts a sign-in or reads a Keychain secret raises an
Approval in every Access mode but full, naming what it will do; the reads of files, folders and pages and the lists run at
once and are logged. A secret reaches the agent only as a `{{secret:<n>}}` placeholder that the daemon swaps back in
inside a call it runs ([ADR 0004](0004-secrets-in-keychain.md), [ADR 0005](0005-claude-code-is-the-integration-layer.md)),
and the operator types one in a masked field of the Session, never in the chat. Playbook steps, Alert Sessions and Repo
Sessions do not get these tools. A no is final, as for `save_file`.

A Session reaches a Connection only through its Connection scope. The operator ticks Connections in the composer, and the
console ticks too: when a `repo` Session is made, every Connection with Access Level `read` that a `.env` file in the Repo's
own checkout names is added to its scope, as ordinary rows the operator may untick later. Only the operator's own local
files count: not a name ending `.example`, `.sample`, `.template` or `.dist`, and not a file git tracks, since a pull
request can change that. A Connection is named by its `host` field or the host of a URL in its config, as a whole token, or,
on this machine, by its port and its database name together. A PR Session has no scope to edit: at each run it reaches the
same Connections found again from the Repo's own checkout, and never from the pull request's branch, with two limits. It
gets no PROD Connection this way, and only Access Level `read`, because it reads pull request text and comments the
operator did not write. An Anonymous Session, and a Repo it clones into, is not matched. A Connection with Access Level
`write` or `none` is never ticked this way, so nothing the console ticks can write, and a PROD Connection with `read` ticked
into a `repo` Session keeps its tag and its PROD write Approval in every Access mode. The daemon reads the file for names
only: its text and values reach no prompt, transcript, log or Action Log row. Jobs keep their own reach.

On any open pull request, the operator's or a teammate's, the push is the console's. In an Address comments Round,
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
- **One Session per press**: each press of Address comments, Check replies or Agent Review opened its own PR action
  Session, one unsubmitted per pull request and action, and its one tool call ended it. It lost because a pull request that
  went through two review rounds ended up with five or six Sessions, each starting cold and forgetting what the last had
  decided, and the Sessions list and the pull request's rail grew with every press.
- **Post into the operator's own Session on the branch**: one conversation with no new Session. It lost because that
  Session loads the code's settings and hooks and has the browser and process tools, which a run on pull request code must
  not have.
- **The agent pushes and posts with its own commands in the PR Session**: the console could not record what was
  posted or post only what failed, and the agent would hold git and host write access on code it did not write.
- **An Approval on every `open_pull_request` call**: the operator read what would be pushed and where. It lost because
  the push is never forced and never merges, the diff and the pull request are on the host to read, and the stop broke
  a chat's flow: an update to an open pull request waited for a click each time.
- **A cap and a queue on the Sessions one `spawn_sessions` call starts**: past the limit, a Session waits for a place. It
  lost because the Approval already shows the count and the operator decides. Every Spawned Session runs at once, and each
  boots its own Claude Code process with every Connection's MCP server, so a large batch slows the console. That cost
  is accepted.
- **Refuse every Notion write, as Figma's**: the operator wants to write back, and Figma is read only by choice.
- **Ask for every Notion tool, reads too**: a Session reading a spec would stop at each search.
- **Run a Notion tool no list names, as a read**: a new delete would run unasked. It asks until the list names it.
- **Run a Shortcut tool whose name no word group places, as a read**: the hosted names are unpublished, so a new delete
  would run unasked. It asks until a word places it.
- **Skip the Notion delete Approval in full access**: deleting in a service outside this Mac is the one thing Full access
  should still ask about.
- **An Approval per Spawned Session**: one click per Repo, each reading one task. It lost because the operator reads the
  whole list once, and a yes per Repo gave back most of the time the batch saves.
- **The console's own tools ask in every Access mode, `full` included** (`save_file`, `spawn_sessions`, `join_repo`,
  `start_process`, `browser_evaluate`, an integration write): the first design. It lost because an operator who chose
  Full access still met a prompt on most turns, and the chip said otherwise. In full access they run at once; the PROD
  write Approval, the merge denial, the Run sandbox and the refusals of sign-in and tokens still hold.
- **The agent asks for a Connection and the operator approves in one click**: the safer option, and offered first. It lost
  because the operator had already said which database a Repo uses by putting it in the Repo's `.env`, and a click on every
  Session that touches data repeated that answer.
- **Every read-only Connection in every Session**: no matching to build. It lost because each server costs seconds of
  start-up and about 20k prompt tokens on every run, and a Session in one Repo would reach the databases of unrelated ones.
- **Tick Connections when the task mentions data**: the agent's own words, or a pull request's text, would pick what it
  reaches.
- **Git host credentials handed to the Run sandbox so the agent pushes itself**: the Bitbucket
  and GitLab CLIs keep their tokens in the Keychain, so it cannot work for them; where it could, a steered run would hold a
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
sandbox, move into a Repo, start a batch of Sessions, save a file outside its folders or change Notion pages, Shortcut stories or Render services with no
click. Steered by text it read, it could do any of these; the operator who set Full access chose that, and a PROD write, a
Notion or Shortcut delete, a Render deploy or environment change and a tool no class places still ask.

An approved `save_file` writes where the operator was shown: the daemon replaces a file of that name in the destination,
which the card says, refuses a folder whose name is taken, and checks nothing else about the destination but that it
exists and is not closed. `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/Library/LaunchAgents`, `~/Library/LaunchDaemons`,
`~/Library/Keychains` and the console's data folder are refused as destinations, links resolved, in every Access mode
including full. The operator reads the path on the card.

A Connection named by a `.env` the operator did not mean to connect, such as a shared host, is reachable read-only from
that Repo's Sessions until they untick it. A PR Session has no untick: only the Repo's file, the Connection's host or its
Access Level changes what it reaches. What remains is this: a pull request's text can still steer a read query on a
non-PROD Connection its Repo's `.env` names, and the result can go back in a reply. A PROD Connection is out of that
reach, and the console ticks a `repo` Session's PROD one only in view of the operator, who can untick it.

A fix waits for the operator. The console shows how long each verified Alert has waited for its
Review. A run steered by log text can execute local commands; the safety lines, the Alert Session's Access mode and the scratch
copy as its working folder steer them there, and the Run sandbox ([ADR 0006](0006-agent-runs-sandboxed-by-the-os.md))
closes only the Keychain, so nothing stops a command from writing elsewhere. A command can read the session token and call the console's API, so a steered run can approve its own Approval. The merge denials, the console's own pushing and the PROD write rule still hold. A reviewer can steer a
PR Session's code change through a comment the operator ticked; the operator's tick, the
worktree and the one pushed commit, never forced, bound that. On a teammate's pull request the
commit lands on their branch under the operator's git identity, for the teammate to see. The PR Session may run the
pull request's own build and tests, so pressing a button runs that branch's code on the operator's Mac, in the
worktree, under the Run sandbox and the Session's Access mode. A pull request from a fork has no branch on origin to fetch, so its
review fails before any code runs.
