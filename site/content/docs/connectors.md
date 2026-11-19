# Connectors

A Connector is an outside service you sign in to once, a folder of logs on your Mac, or an AWS profile the console reads logs with. It holds the sign-in, the folder or the profile and registers the service's MCP Server when it has one. You connect, check and disconnect Connectors in Integrations, the one place a source is connected.

## The fourteen Connectors

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
| CloudWatch logs | The `aws` CLI and AWS's CloudWatch MCP server, started with `uvx` |

The agent reaches each service through Claude Code, with the service's own MCP server or CLI. OpenTelemetry logs has no service to reach. The console holds no extra copy of your access beyond the sign-in it keeps in the Keychain, and it stores no AWS key: CloudWatch logs uses the credentials where the AWS CLI keeps them.

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

## CloudWatch logs

This Connector gives Monitor a third log source. It reads the CloudWatch Log groups you pick, in one AWS region, with an AWS CLI profile on your Mac.

You need the `aws` CLI and `uvx` on your PATH. When one is missing, Connect stops and Integrations names the tool and the command that installs it. The console installs neither.

Set it up in Integrations:

1. Enter the AWS profile and the region, such as `us-east-1`.
2. Pick Log groups from the list the profile can see. Each picked group is one Service. Its Service name starts as the last path segment of the group, so `/ecs/shop-api` becomes `shop-api`, and its env starts as `prod`. You can edit both. Two groups with the same Service name and env are refused.
3. Press Connect. The Connector reads connected when the AWS CLI answers for the profile, and needs auth when it does not. For an Identity Center profile, Connect runs the AWS CLI's browser sign-in (`aws sso login`) and Cancel stops the wait. For any other profile, run `aws login` in a terminal and press Connect again.

One Connector reads one region. Each connected log source runs its own Scan schedule, with its own Check interval and daily scan time.

### What a Scan reads

A Scan runs two Logs Insights queries for each picked Log group. The first counts failing events per 10-minute bucket for each status code, method, path and message. The second reads the newest failing events as Samples, at most 10,000 per Log group. When the cap stops the read, the Scan says so.

A query that has not finished after 5 minutes is stopped, and the Scan reports that Log group as not read. Stopping a Scan stops its running queries.

AWS bills Logs Insights per GB scanned. The Scan's notes show the bytes the Scan scanned. The console sets no limit on them.

### Log fields

The reader expects one JSON object per log line. For each field it takes the first name in the list that the line has:

| Field | Names |
| ----- | ----- |
| Status code | `status`, `statusCode`, `status_code`, `http.status_code` |
| Method | `method`, `httpMethod`, `http.method` |
| Route | `route`, `path`, `resourcePath`, `url.path` |
| Level | `level`, `severity`, `log_level` |
| Message | `message`, `msg` |
| Time | The time CloudWatch recorded for the event |

An event counts as failing when its status code is 400 or more, or its level is `error`, `critical`, `alert`, `emergency` or `fatal`, in any case. This line in `/ecs/shop-api` is a failing event:

```json
{"level":"error","message":"payment provider timed out","method":"POST","route":"/checkout","status":502}
```

A line that is not JSON has none of these fields and is not read as a failure. Plain-text logs, ALB access logs and API Gateway access logs are not read.

### Access for the console and the agent

Use a profile with the `CloudWatchLogsReadOnlyAccess` policy. The console cannot read a profile's rights, so it trusts you to grant only that. The console writes nothing to AWS.

Connect registers AWS's CloudWatch MCP server with Claude Code in every Claude account, started with `uvx` and your profile. It starts for a Verification of a CloudWatch Alert and for a chat with no Alert. It does not start for a Fix, a pull request job or a review. The agent may use only its four log tools: list Log groups, run a Logs Insights query, read the results and cancel the query.

That server runs outside the Run sandbox, as Claude Code starts it, and it has the rights the profile has. The sandbox's block on `~/.aws` does not apply to it.

Alerts and Services from this source carry a CloudWatch label in Monitor. A Verification or a Fix of a CloudWatch Alert starts with a Recheck of its Log group for the last hour, and the Report's evidence section is headed "Log evidence". Disconnect removes the MCP server and leaves the AWS profile and the account as they are.

## Checks and Disconnect

The console checks each connected Connector in the background, and again when its last check is older than 10 minutes. A failing check shows why, and recovering shows too.

Disconnect stops the console using the service, deletes its token from your Keychain and, where the service allows it, takes the access back at the service. The Connector then reads off.

## MCP Servers and Connections

Integrations also lists MCP Servers, which give the agent tools such as Slack or a database. The console registers each one in every Claude account you use. They are separate from Connections, which are the databases the agent may query, each with an Environment and an Access Level.

## Integration commands

For the CLIs (`pup`, `gh`, `glab`, `bkt`, `slashdocs`), the agent asks the console to run a command through its `run_integration` tool. A read runs at once. A write needs your Approval, unless the Session is in full mode or you chose "Don't ask again this Session" for that CLI. Sign-in, tokens and merges are refused.
