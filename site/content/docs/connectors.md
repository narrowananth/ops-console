# Connectors

A Connector is an outside service you sign in to once, a folder of logs on your Mac, an AWS profile, a Loki URL or a New Relic account the console reads logs with. It holds the sign-in, the folder, the profile, the URL or the account and registers the service's MCP Server when it has one. You connect, check and disconnect Connectors in Integrations, the one place a source is connected.

## The sixteen Connectors

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
| Loki logs | The `logcli` CLI, with a Loki URL and a secret kept in the Keychain |
| New Relic logs | The `newrelic` CLI, with an account ID and a User API key kept in the Keychain |

The agent reaches each service through Claude Code, with the service's own MCP server or CLI. OpenTelemetry logs has no service to reach. The console holds no extra copy of your access beyond the sign-in it keeps in the Keychain, and it stores no AWS key: CloudWatch logs uses the credentials where the AWS CLI keeps them. Loki logs and New Relic logs have no sign-in the console can use, so you type the secret or key once and the console keeps it in the Keychain.

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

## Loki logs

This Connector gives Monitor a fourth log source. It reads the logs in a Grafana Loki, on Grafana Cloud or self-hosted, with Loki's own CLI, `logcli`. It registers no MCP Server.

You need `logcli` on your PATH. When it is missing, Connect stops and Integrations names the tool and the command that installs it, `brew install logcli`. The console installs nothing.

Loki has no browser sign-in the console can use, so you type the secret once in Integrations. The console keeps it in the macOS Keychain and never shows it again. The pane shows only whether a secret is set, and typing a new one replaces it. The URL holds no user name or token: Connect refuses one, and credentials go in the secret field.

### Grafana Cloud

1. Enter the Loki URL of your Grafana Cloud stack.
2. Choose basic auth. The username is the Loki instance ID.
3. For the secret, use an access-policy token with the `logs:read` scope.

### Self-hosted Loki

1. Enter the Loki URL.
2. Enter the org id if your Loki has tenants. It is sent as the `X-Scope-OrgID` header. Leave it empty for none.
3. Choose the auth mode your Loki or its proxy takes: none, bearer or basic. A bearer mode needs a secret. A basic mode needs a username and a secret.

### Fields

| Field | Meaning | Default |
| ----- | ------- | ------- |
| Service label | The stream label whose values name the Services | `service_name` |
| Env label | The stream label that says which env a stream belongs to. A stream without it reads as `no env`. | `deployment_environment_name` |
| Selector | Extra stream matchers that narrow what a Scan reads, such as `cluster="prod-1"` | Empty |
| Format | `JSON` or `logfmt`, the format of the log lines | `JSON` |

Promtail setups often label the env as `env`. Change the env label to match your streams.

One Connector reads one Loki URL. Each connected log source runs its own Scan schedule, with its own Check interval and daily scan time.

### What a Scan reads

A Scan finds the Services from the values of the service label over the Scan's window, inside the selector. It then runs two queries for each Service. The first counts failing lines per 10-minute bucket. The second reads the newest failing lines as Samples, at most 5,000 per Service. When a Service has more, a Route with one message group takes its count and 10-minute peak from the first query, and a Route with several message groups counts the newest 5,000 lines read. The Scan's notes say so. Loki's own query limits apply, and a query Loki refuses fails the source with Loki's reason shown.

### Log fields

The reader expects every log line in the format the Connector names. For each field it takes the first name in the list that the parsed line has:

| Field | Names |
| ----- | ----- |
| Status code | `status`, `statusCode`, `status_code`, `http_status_code` |
| Method | `method`, `httpMethod`, `http_method` |
| Route | `route`, `path`, `resourcePath`, `url_path` |
| Level | `level`, `severity`, `log_level` |
| Message | `message`, `msg` |
| Time | The time Loki stores for the line |

A line counts as failing when its status code is 400 or more, or its level is `error`, `critical`, `alert`, `emergency` or `fatal`, in any case. This line in a `shop-api` stream is a failing line:

```json
{"level":"error","message":"payment provider timed out","method":"POST","route":"/checkout","status":502}
```

A line that does not parse has none of these fields and is not read as a failure. Plain-text logs and access logs are not read. Loki behind a Grafana instance is not supported: the URL must be Loki's own.

### Access for the console and the agent

The console reads logs and writes nothing to Loki, and a PROD env is read-only like any other. The daemon calls `logcli` as you, outside the Run sandbox, and passes the address, org id and secret in the command's environment, never on its command line.

A Verification or a Fix of a Loki Alert starts with a Recheck that counts the Alert's failing lines for the last hour, and the Report's evidence section is headed "Log evidence". The agent's brief gives it the Samples. When it needs more logs, the agent reads them through `logcli`, run by the console as an Integration command. It may use the read commands, which are a log or metric query, listing labels and label values, and series, with a fixed set of flags for time range, limit, output format and quiet. It cannot change the address, the org id, the credentials, the TLS settings or a proxy, and the secret never reaches it.

Alerts and Services from this source carry a Loki label in Monitor. Disconnect removes the secret from the Keychain and leaves Loki untouched.

## New Relic logs

This Connector gives Monitor a fifth log source. It reads the logs in a New Relic account with New Relic's own CLI, `newrelic`. It registers no MCP Server.

You need `newrelic` on your PATH. When it is missing, Connect stops and Integrations names the tool and the command that installs it, `brew install newrelic-cli`. The console installs nothing.

The `newrelic` CLI has no browser sign-in, so you type a User API key once in Integrations. It starts with `NRAK-`. The console keeps it in the macOS Keychain and never shows it again. The pane shows only whether a key is set, and typing a new one replaces it.

### Account and region

1. Enter the account ID. In one.newrelic.com, open the user menu, then Administration, Access management and Accounts. The ID is a number.
2. Choose the region of the account: US, EU or JP. A key belongs to one region, so pick the region the key was made in. A check that fails with needs auth means the key or the region is wrong.
3. Paste the User API key.

### Fields

| Field | Meaning | Default |
| ----- | ------- | ------- |
| Service attribute | The attribute whose values name the Services | `service.name` |
| Env attribute | The attribute that says which env an event belongs to. An event without it reads as `no env`. | `environment` |
| Filter | One extra condition that narrows what a Scan reads, such as `cluster = 'prod-1'` | Empty |

The filter is one condition of the kind that follows `WHERE`. Connect refuses a filter that holds a semicolon or a clause the reader adds itself, such as `SINCE`, `UNTIL`, `LIMIT`, `FACET`, `TIMESERIES` or `ORDER BY`.

One Connector reads one account. Each connected log source runs its own Scan schedule, with its own Check interval and daily scan time.

### What a Scan reads

A Scan finds the Services from the distinct values of the service attribute on failing events over the Scan's window, inside the filter. It then runs two queries for each Service. The first counts failing events per 10-minute bucket. The second reads the newest failing events as Samples, at most 5,000 per Service. When a Service has more, a Route with one message group takes its count and 10-minute peak from the first query, and a Route with several message groups counts the newest 5,000 events read. A window longer than 61 hours counts only the newest 61 hours. The Scan's notes say so. New Relic's own query limits apply, and a query New Relic refuses fails the source with New Relic's reason shown.

### Log fields

The reader asks New Relic which attributes a Service's logs have, once per Service. For each field it takes the first name in the list that the logs have:

| Field | Names |
| ----- | ----- |
| Status code | `http.response.status_code`, `http.status_code`, `status`, `statusCode`, `status_code` |
| Method | `http.request.method`, `http.method`, `method`, `httpMethod` |
| Route | `http.route`, `url.path`, `route`, `path`, `resourcePath` |
| Level | `level`, `severity.text`, `severity`, `log_level` |
| Message | `message`, `msg` |
| Time | The event's own timestamp |

An event counts as failing when its status code is 400 or more, or its level is `error`, `critical`, `alert`, `emergency` or `fatal`, in any case. A Service whose logs have no status attribute is read by level only. This event for `shop-api` is a failing event:

```json
{"service.name":"shop-api","level":"error","message":"payment provider timed out","http.request.method":"POST","http.route":"/checkout","http.response.status_code":502}
```

Plain-text and access-log formats are not read. The reader uses the attributes New Relic has already parsed.

### Access for the console and the agent

The console reads logs and writes nothing to New Relic, and a PROD env is read-only like any other. The daemon calls `newrelic` as you, outside the Run sandbox, and passes the key, account ID and region in the command's environment, never on its command line. New Relic's hosted MCP server is not used.

A Verification or a Fix of a New Relic Alert starts with a Recheck that counts the Alert's failing events for the last hour, and the Report's evidence section is headed "Log evidence". The agent's brief gives it the Samples. When it needs more logs, the agent reads them through `newrelic`, run by the console as an Integration command. It may run only `nrql query`, with a query and an output format. It cannot change the key, the account or the region, and the key never reaches it.

Its NRQL can read any event type in the account, not only logs. A User key reaches every account its user can open. Create a dedicated user with a read-only role for the console. New Relic documents no read-only key, so permissions come from the user's roles.

Alerts and Services from this source carry a New Relic label in Monitor. Disconnect removes the key from the Keychain and leaves New Relic untouched.

## Checks and Disconnect

The console checks each connected Connector in the background, and again when its last check is older than 10 minutes. A failing check shows why, and recovering shows too.

Disconnect stops the console using the service, deletes its token from your Keychain and, where the service allows it, takes the access back at the service. The Connector then reads off.

## MCP Servers and Connections

Integrations also lists MCP Servers, which give the agent tools such as Slack or a database. The console registers each one in every Claude account you use. They are separate from Connections, which are the databases the agent may query, each with an Environment and an Access Level.

## Integration commands

For the CLIs (`pup`, `gh`, `glab`, `bkt`, `slashdocs`), the agent asks the console to run a command through its `run_integration` tool. A read runs at once. A write needs your Approval, unless the Session is in full mode or you chose "Don't ask again this Session" for that CLI. Sign-in, tokens and merges are refused.
