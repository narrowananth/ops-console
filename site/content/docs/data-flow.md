# Data flow

This page says what moves between your Mac, Anthropic's API and each Connector, and that none of it reaches an Ops Console server. The project runs no server your installation talks to. The [privacy policy](PRIVACY.md) has the short version.

## Who calls the service

- **The console's own calls.** A Scan, a Health check, a Recheck, a pull request list and a Pull request opening go from the daemon on your Mac to the service. No model turn is involved. What comes back stays on your Mac.
- **The agent's calls.** An MCP Server tool, the output of a `run_integration` command and a file the agent reads each return their result to the agent, and that result goes on to Anthropic's API as part of the run.
- **The agent's commands.** A command a run executes, such as a build, a test, a package install or `curl`, goes from your Mac straight to the host it names. The Run sandbox does not limit hosts, so a command in a run can reach any server your Mac can, and the agent's web tools are open. Whatever such a command returns goes to the agent and on to Anthropic's API.
- **The Browser panel and Terminals.** A page in a Session's Chrome calls whatever hosts it calls, as in your own browser, and a Terminals process runs as you. Neither goes through a model, and the panel lists the outside hosts a page called.

Samples and Reports the console stores reach Anthropic only when a Verification or a Fix puts them in a prompt. This holds for the records of a Log folder too: the daemon reads the folder on your Mac, and the agent never does.

## By route

| Route | Connectors | Who calls the service | Where the result goes |
| ----- | ---------- | --------------------- | --------------------- |
| CLI the daemon calls | Datadog (`pup`), GitHub (`gh`), GitLab (`glab`), Bitbucket (`bkt`), slashdocs | The daemon, for the console's own reads. For the agent, the daemon runs the command it asks for through `run_integration`: a read at once, a write after your Approval unless the Session is in full mode or you chose not to be asked again. | A console read stays on your Mac. A command the agent asked for returns its output to the agent, so it goes to Anthropic's API. |
| Hosted MCP server | Loki logs, New Relic logs | The daemon, for Scans of Loki and New Relic, with no model turn. It calls Grafana Cloud's tools with a token it holds in your Keychain, which it got by signing in itself. It calls New Relic's tools with the sign-in Claude Code stored for that server, which it reads at the moment of the call and never writes or refreshes. For the agent, Claude Code calls the same servers, registered by Connect, with its own sign-in. When you choose the User API key route for New Relic, the daemon calls New Relic's own API (NerdGraph) with your key, which sits in your Keychain, and the agent asks the console to run its NRQL queries, so the agent never holds the key. | A console read stays on your Mac. What a server returns to the agent goes to Anthropic's API. Loki lines and New Relic events reach Anthropic only as Samples in a prompt or as the agent's tool output. |
| MCP Server Claude Code calls | Jira, Slack, Sentry, Shopify, GitHub, Datadog, and Bitbucket through Atlassian | Claude Code, from your Mac, with the sign-in the Connector holds | The agent, then Anthropic's API |
| Log folder | OpenTelemetry logs | The daemon, which reads the folder on your Mac as you, read only. No service is called. | A console read stays on your Mac. The records reach Anthropic's API only as Samples in a prompt. The agent never reads the folder. |
| AWS CLI and MCP Server | CloudWatch logs | The daemon, which calls the AWS CLI as you with your profile, for the console's own reads. For the agent, Claude Code starts AWS's CloudWatch MCP server on your Mac, and it calls AWS from there with the same profile. | A console read stays on your Mac. What the MCP server returns goes to the agent, then Anthropic's API. Events reach Anthropic only as Samples in a prompt or as the agent's tool output. |
| Google bridge | Google Docs, Google Sheets, Google Drive | The bridge the console ships, which calls the product's REST API when the agent calls a Google tool | The agent, then Anthropic's API. The agent never sees the refresh token, which stays in your Keychain. |

Secrets stay in your Keychain and are read at the moment of use.

## Anthropic's API

With the console's own Claude accounts, the agent's prompts, the files it reads and every tool result go to Anthropic's API under the active Claude account, and Anthropic handles them under its own terms.

With CLIProxy as the Claude account hub, they go to a CLIProxy server on your Mac, which sends them on to the providers you configured. The address must be a loopback address.

Claude Code, which the console runs, has its own traffic to Anthropic and its own settings. The console sets no opt-out for it and makes no promise about it. Anthropic's terms and your Claude Code settings decide.

## Production data

Rows the agent reads from a PROD Connection are part of what goes to Anthropic's API. The Access Level of a Connection limits what the agent may do with it.

## The project's servers

None of the above goes to the project. The only requests tied to the project go to GitHub: the update check asks for the latest release, when the console checks for a new version and when you run `ops-console update`, and an update downloads from it. GitHub sees those requests. The app never calls opsconsole.org, which is a static site.

See [Safety](/docs/safety/) for what keeps the server local, and the [privacy policy](PRIVACY.md) for what is stored on your Mac and how to remove it.
