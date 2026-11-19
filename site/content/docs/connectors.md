# Connectors

A Connector is an outside service you sign in to once, or a folder of logs on your Mac. It holds the sign-in or the folder and registers the service's MCP Server when it has one. You connect, check and disconnect Connectors in Integrations, the one place a source is connected.

## The thirteen Connectors

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
| OpenTelemetry logs | A Log folder on your Mac, read by the daemon |

The agent reaches each service through Claude Code, with the service's own MCP server or CLI. OpenTelemetry logs has no service to reach. The console holds no extra copy of your access beyond the sign-in it keeps in the Keychain.

## Connect

Press Connect on a Connector. Its sign-in opens in your browser, and when you finish, the Connector reads connected. Cancel stops the wait. Where a CLI needs installing, the console can install it with Homebrew.

Slack, Atlassian, Sentry and other MCP servers sign in with their own OAuth. GitHub uses the `gh` device sign-in: the console shows a one-time code to enter on GitHub. Bitbucket's CLI keeps its own token.

## OpenTelemetry logs

This Connector gives Monitor a second log source beside Datadog. It reads a Log folder: OTLP JSON lines that an OpenTelemetry Collector's `file` exporter writes on your Mac. There is no sign-in. You choose the folder in Integrations, and the Connector reads connected when the folder exists and the console can read it.

What a Scan reads:

- `.json` and `.jsonl` files directly in the folder, not in its subfolders. Gzip and protobuf files are ignored.
- The newest files first, and at most 100 MB per Scan. When the cap stops the read, the Scan says so.
- Lines that are not valid log records are skipped, and the Scan says how many.

A Collector config that writes into the folder:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318

exporters:
  file:
    path: /Users/you/otel-logs/logs.jsonl

service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [file]
```

The `file` exporter ships in the Collector's contrib distribution. Leave compression off so the file is plain JSON lines. Add `rotation` settings if you want the exporter to roll the file, and keep the rolled files in the same folder.

A record counts as failing when its status code is 400 or more, or its severity number is 17 or more. The Connector reads these attributes:

| Field | Attribute |
| ----- | --------- |
| Service | `service.name` |
| Env | `deployment.environment.name`, else `deployment.environment`, else `no env` |
| Status code | `http.response.status_code`, else `http.status_code` |
| Method | `http.request.method`, else `http.method` |
| Route | `http.route`, else `url.path` |
| Severity | The record's severity number |

Alerts and Services from this source carry an OpenTelemetry label in Monitor, and a Verification or a Fix starts with a Recheck of the folder for the last hour. The agent never reads the folder. It works from the Samples in its brief and says in the Report when it needed more. The console only reads the folder and never writes in it. Disconnect leaves the folder and its files as they are.

## Checks and Disconnect

The console checks each connected Connector in the background, and again when its last check is older than 10 minutes. A failing check shows why, and recovering shows too.

Disconnect stops the console using the service, deletes its token from your Keychain and, where the service allows it, takes the access back at the service. The Connector then reads off.

## MCP Servers and Connections

Integrations also lists MCP Servers, which give the agent tools such as Slack or a database. The console registers each one in every Claude account you use. They are separate from Connections, which are the databases the agent may query, each with an Environment and an Access Level.

## Integration commands

For the CLIs (`pup`, `gh`, `glab`, `bkt`, `slashdocs`), the agent asks the console to run a command through its `run_integration` tool. A read runs at once. A write needs your Approval, unless the Session is in full mode or you chose "Don't ask again this Session" for that CLI. Sign-in, tokens and merges are refused.
