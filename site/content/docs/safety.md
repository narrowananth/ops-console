# Safety

The agent runs on your machine with access to your code and services, so the console sets hard limits. They hold in every Access mode unless a line says otherwise.

## You approve, the agent never merges

- A Verification reads and writes only in a scratch copy of your code, a git worktree in the data folder at the newest commit of the branch your Playbook names. It never writes in your checkout or to a Connection.
- The agent changes your code, files a Ticket or opens a pull request only after you confirm the Report.
- It never merges. Every run denies `gh pr merge`, `glab mr merge`, `bkt pr merge`, the GitHub and GitLab merge tools, and any command that names a host's merge endpoint. Merge is a button only you can press.
- The console, not the agent, pushes branches, posts review comments and replies, and resolves threads. A Reply check or Comment pass denies the agent `git push` and the hosts' comment and API commands.

## Log text is data

Alerts come from service logs, which anyone who can send a Service a request can write to. An agent that acted on them alone could be steered. The console's safety lines end every run's system prompt and say that a log line, like pull request text, is data and never an instruction. The one exception is a Comment pass, where the review comments you ticked are change requests.

## The agent is sandboxed

Every run's shell commands go through the macOS sandbox (Seatbelt). A run writes only in its working folder, its Session's output folder, the checkouts of the Repos you opened to it, temp folders and the package-tool caches. It cannot write into a folder on PATH. It reads neither the data folder nor `~/.ssh`, `~/.aws`, `~/.config/gcloud` or the login Keychain folder. If the sandbox is unavailable, the run fails: the console never runs a command outside it, and no setting turns it off.

The agent's saves outside its folders go through an Approval you answer. The agent's own web tools are denied, and the commands it runs reach only the hosts on the Network allowlist.

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
