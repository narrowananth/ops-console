# Connectors

A Connector is an outside service you sign in to once. It holds the sign-in and registers the service's MCP Server when it has one. You connect, check and disconnect Connectors in Integrations, the one place a service is connected.

## The twelve Connectors

| Connector | How the console reaches it |
| --------- | -------------------------- |
| Datadog | `pup` CLI and the `datadog-pup` MCP server |
| Jira | Atlassian MCP |
| GitHub | `gh` CLI and the GitHub MCP server |
| GitLab | `glab` CLI |
| Bitbucket | `bkt` CLI and Atlassian MCP |
| Slack | Slack MCP |
| Sentry | Sentry MCP |
| Shopify | Shopify Dev MCP |
| slashdocs | `slashdocs` CLI |
| Google Docs | The console's Google tools, over the Google Docs API |
| Google Sheets | The console's Google tools, over the Google Sheets API |
| Google Drive | The console's Google tools, over the Google Drive API |

The agent reaches each service through Claude Code, with the service's own MCP server or CLI. The console holds no extra copy of your access beyond the sign-in it keeps in the Keychain.

## Connect

Press Connect on a Connector. Its sign-in opens in your browser, and when you finish, the Connector reads connected. Cancel stops the wait. Where a CLI needs installing, the console can install it with Homebrew.

Slack, Atlassian, Sentry and other MCP servers sign in with their own OAuth. GitHub uses the `gh` device sign-in: the console shows a one-time code to enter on GitHub. Bitbucket's CLI keeps its own token.

## Checks and Disconnect

The console checks each connected Connector in the background, and again when its last check is older than 10 minutes. A failing check shows why, and recovering shows too.

Disconnect stops the console using the service, deletes its token from your Keychain and, where the service allows it, takes the access back at the service. The Connector then reads off.

## MCP Servers and Connections

Integrations also lists MCP Servers, which give the agent tools such as Slack or a database. The console registers each one in every Claude account you use. They are separate from Connections, which are the databases the agent may query, each with an Environment and an Access Level.

## Integration commands

For the CLIs (`pup`, `gh`, `glab`, `bkt`, `slashdocs`), the agent asks the console to run a command through its `run_integration` tool. A read runs at once. A write needs your Approval, unless the Session is in full mode or you chose "Don't ask again this Session" for that CLI. Sign-in, tokens and merges are refused.
