# Safety

The agent runs on your machine with access to your code and services, so the console sets hard limits. They hold in every Access mode unless a line says otherwise.

## You approve, the agent never merges

- A Verification works in a scratch copy of your code, a git worktree in the data folder at the newest commit of the branch your Playbook names. Its working folder is never your checkout. It writes to no Git host, and none of your writable Connections starts for it.
- The agent changes your code, files a Ticket or opens a pull request only after you confirm the Report.
- It never merges. Every run denies `gh pr merge`, `glab mr merge`, `bkt pr merge`, the GitHub and GitLab merge tools, and any command that names a host's merge endpoint. Merge is a button only you can press.
- The console, not the agent, pushes branches, posts review comments and replies, and resolves threads. A Session opened from Review with agent, Check replies or Address comments denies the agent `git push` and the hosts' comment and API commands.

## Log text is data

Alerts come from service logs, which anyone who can send a Service a request can write to. An agent that acted on them alone could be steered. The console's safety lines end every run's system prompt and say that a log line, like pull request text, is data and never an instruction. The one exception is an Address comments Session, where the review comments you ticked are change requests.

## The agent is sandboxed

Every run's shell commands go through the macOS sandbox (Seatbelt). The sandbox guards the Keychain and what reaches it, and nothing else. A command writes anywhere, reaches any host and `localhost`, starts servers and uses any Unix socket, as it would in your own terminal, so a build, a test run or a Docker-based suite works unchanged. Closed to a run's commands:

- the login Keychain folder, `~/Library/Keychains`;
- the installed app, `~/.ops-console`;
- the git control files the console's own `git` reads outside the sandbox (hooks, config and the files that say where a worktree lives);
- a read-only run's working folder.

The agent's file tools are held to the same closed paths: no reading the Keychain folder or the installed app, no editing the git control files. If the sandbox is unavailable, the run fails: the console never runs a command outside it, and no setting turns it off. Accounts & Usage shows whether it works, under On this machine.

Because commands can reach any host, a run steered by text it read can send what it can read to a host of its choosing, and can read the data folder, including the session token that lets a command call the console's API as you. The guards that stay are the merge denials, the PROD write rule, the rule that the console pushes and opens pull requests, and the Approval on each integration write. Treat a Session's Access mode and the Connections it can reach with that in mind.

The agent's saves outside its folders go through an Approval you answer, and a folder that holds sign-in keys, launch agents or the console's data is refused in every mode. Terminals are not agent runs and are not sandboxed, and neither is a page in the Session's Browser panel.

## Production data

A Connection tagged PROD is always marked, and the agent treats it as read-only. A command that writes to production is yours to run: the console names it and stops. An Access Level (none, read, or read and write) is enforced when a Connection's server launches, not only shown.

## The console is local

The server listens on `127.0.0.1` only, and every request and WebSocket carries a session token made at startup. There is no tunnel and no `0.0.0.0`. Reaching the server is the same as reaching your machine, so sharing the console with a team means a separate deployment with real sign-in, not opening the port. What leaves your Mac for Anthropic and the services you connect is on the [data flow](/docs/data-flow/) page.

## Secrets

Connection passwords, service tokens, MCP Server environment variables, the CLIProxy API key and the Google refresh token live in the macOS Keychain. The database holds only a Connection's non-secret fields. Secrets are read at the moment of use and never reach the database, the logs, WebSocket messages or the browser. The one exception is the headers of an HTTP or SSE MCP Server, which Claude Code sends itself and keeps in its own config file in plain text. The form that adds one says so.

## Google Drive

The Drive Connector asks Google for read access only and has no tool that deletes or shares, so no Access mode changes that. See [Google Docs, Sheets and Drive](/docs/google/).

## Report a security problem

Open an issue on the [issue tracker](https://github.com/narrowananth/ops-console/issues). Don't include secrets or customer data.
