# Privacy policy

Effective 19 November 2026.

Ops Console is open-source software that runs on your own Mac. This page says what it stores, what leaves your Mac and where it goes, and how to remove it.

## Who runs what

The project publishes the code and the release downloads. It runs no server that your installation talks to for your work, and it receives no accounts, files, prompts or usage statistics from you. Ops Console has no telemetry or analytics.

The console's own server listens on `127.0.0.1` only, and every request carries a session token made at startup. Other devices on your network cannot reach it.

## This website

opsconsole.org is a static site on Cloudflare. It sets no cookies, runs no analytics or trackers, and loads no fonts or scripts from other sites. Cloudflare, like any host, sees your IP address and browser details in its request logs. The release notes page asks GitHub's API for the list of releases from your browser, so GitHub sees that request. The app itself never calls the site.

## What stays on your Mac

The data folder, `~/Library/Application Support/ops-console`, holds:

- the console's database (`state.db`): Connections without their secrets, Sessions and their messages, Alerts, Reports, Playbooks, runs and settings
- files you attach to a Session, and files the agent writes for you
- scratch copies of repositories the agent works in
- each Claude account's configuration folder, and local MCP Server files

The daemon log is `~/Library/Logs/ops-console/daemon.log`.

Secrets are kept in your macOS Keychain, not in the database, the log or the browser: Connection passwords, service tokens, the CLIProxy API key, an MCP Server's environment variables and the Google refresh token. One exception is the headers of an HTTP or SSE MCP Server, which Claude Code sends itself and keeps in its own configuration file in plain text. The form that adds one says so.

Text the agent reads or writes, including what a tool returned from a database or a service, is saved in your Session history on your Mac until you delete it.

## Data flow

Three parties handle your data: your Mac, Anthropic's API and the services you connect (Connectors). The project's own servers are not one of them.

- **Your Mac** holds the console, its database, your Session history and your secrets. The console's own checks and lists, such as a Scan, a Health check or a pull request list, go from your Mac to the service and back. No model reads them, and the results stay on your Mac.
- **Anthropic's API**, the AI provider behind your Claude account, receives what the agent works with: your prompts, the files it reads and what each tool it calls returns. That includes a Connector's answer to an agent request and rows from a Connection. With CLIProxy, the same data goes to a CLIProxy server on your Mac and from there to the providers you configured.
- **A Log folder** is read on your Mac. No service is involved, and its records reach Anthropic's API only as Samples in a prompt.
- **CloudWatch logs** are read by the AWS CLI, which the console runs on your Mac with your AWS profile. The agent's CloudWatch MCP server also runs on your Mac and calls AWS with that profile. The events reach Anthropic's API only as Samples in a prompt or as the agent's tool output.
- **Loki logs** are read through Grafana Cloud's hosted MCP server. The console signs in to Grafana itself and keeps the token in your Keychain. The daemon calls the server's tools on your Mac for each Scan. The agent reaches Loki through the same server, registered with Claude Code. The lines reach Anthropic's API only as Samples in a prompt or as the agent's tool output.
- **New Relic logs** are read through New Relic's hosted MCP server. The sign-in belongs to Claude Code, and the daemon reads the token Claude Code stored for that server at the moment of each call. It never writes or refreshes it. The agent reaches New Relic through the same server, registered with Claude Code. The events reach Anthropic's API only as Samples in a prompt or as the agent's tool output.
- **A Connector** receives the requests you or the agent make with your sign-in, and answers them. An answer to one of the console's own checks stays on your Mac. An answer to the agent goes on to Anthropic's API.

None of this reaches an Ops Console server. The only requests tied to the project go to GitHub: the update check asks for the latest release, and an update downloads from it. The app never calls opsconsole.org. Claude Code, which the console runs, has its own traffic to Anthropic under Anthropic's terms and your Claude Code settings. The console does not change it.

The [data-flow page](https://opsconsole.org/docs/data-flow/) lists each route.

## What leaves your Mac

Ops Console sends nothing to the project. These things go elsewhere, because you asked for them:

| To | What | When |
| -- | ---- | ---- |
| The AI provider behind your Claude account, or the CLIProxy you set up | Your prompts, the files the agent reads, and the results of every tool it uses, which can include database rows, logs, pull requests, messages and documents | Whenever the agent runs. That provider handles it under its own terms. CLIProxy runs on your own machine and passes it to the providers you configured. |
| The services you connect: Datadog, GitHub, GitLab, Bitbucket and Atlassian, Slack, Sentry, Shopify, slashdocs, Google, AWS CloudWatch, Grafana Cloud, New Relic | Requests the console or the agent makes with your sign-in, and what they return | When you connect, check or use the service, or the agent calls one of its tools |
| Your databases and other servers added as Connections or MCP Servers | Queries the agent runs and what they return | When the agent uses them. The Access Level and PROD tag of a Connection limit what it may do. |
| GitHub | A request for the latest release, and the download of an update | When you run `ops-console update`, and when the console checks for a new version |
| Websites | The pages you or the agent open in a Session's Browser panel | When a page is opened |
| npm and other package sources | Package downloads for tools such as an MCP Server that starts with `npx` | When that server starts |

Rows the agent reads from a production database are part of what goes to the AI provider. Decide which Connections the agent may read before you give it one.

## Google data

You can connect Google Docs, Google Sheets and Google Drive. Each connection asks Google for one permission, which you approve on Google's own sign-in page:

| Connector | Permission | What it allows |
| --------- | ---------- | -------------- |
| Google Docs | `documents` | Read and edit your Google Docs |
| Google Sheets | `spreadsheets` | Read and edit your Google Sheets |
| Google Drive | `drive.readonly` | Search and read your Drive files, and change nothing |

Each connection also asks for your email address, to show which Google account is connected.

Ops Console reads or changes a file only when the agent calls one of these tools. It does not browse your files in the background. The refresh token stays in your Keychain, and the agent never sees it. An access token lasts at most an hour and lives in memory. File contents a tool returns go to the agent and the AI provider, as in the table above. The project does not receive them, does not sell, rent or share them, and does not use them for advertising or to train AI models.

Ops Console's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Your control

- **Disconnect** a Connector in Integrations. Ops Console deletes its token from your Keychain and revokes its access at the service where the service allows it. For Google, it keeps the access when another connected Google Connector uses the same Google account.
- **Revoke access at the service**, for example on your [Google account's third-party access page](https://myaccount.google.com/connections) or in GitHub's settings.
- **Delete history** by deleting a Session in Ops Console, or by deleting the data folder.
- **Uninstall** with `ops-console uninstall`. It leaves the data folder and logs. Delete them yourself, and the Keychain items under the service `ops-console`, to remove everything.

## Children

Ops Console is a developer tool and is not meant for children.

## Changes and contact

When this policy changes, the new text is committed to this repository with its date. Questions go to the project's [issue tracker](https://github.com/narrowananth/ops-console/issues).
