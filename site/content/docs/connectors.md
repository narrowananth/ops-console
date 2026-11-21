# Connectors

A Connector is an outside service you sign in to once, a folder of logs on your Mac, an AWS profile, a Grafana Cloud stack or a New Relic account the console reads logs with. It holds the sign-in, the folder, the profile, the stack or the account and registers the service's MCP Server when it has one. You connect, check and disconnect Connectors in Integrations, the one place a source is connected.

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
| Loki logs | Grafana Cloud's hosted MCP server, signed in by the console itself with a token kept in the Keychain |
| New Relic logs | New Relic's hosted MCP server, signed in through Claude Code, or New Relic's own API with your User API key |

The agent reaches each service through Claude Code, with the service's own MCP server or CLI. OpenTelemetry logs has no service to reach. The console holds no extra copy of your access beyond the sign-in it keeps in the Keychain, and it stores no AWS key: CloudWatch logs uses the credentials where the AWS CLI keeps them. Loki logs, New Relic logs and CloudWatch logs have no field to fill in before Connect. A choice the sign-in cannot find, such as a New Relic Region, sits above the Connect button, and a choice the sign-in can list, such as an account, appears after you sign in.

## Connect

Press Connect on a Connector. Its sign-in opens in your browser, and when you finish, the Connector reads connected. Cancel stops the wait. Where a CLI needs installing, the console can install it with Homebrew.

Slack, Atlassian, Sentry and other MCP servers sign in with their own OAuth. GitHub uses the `gh` device sign-in: the console shows a one-time code to enter on GitHub. Bitbucket's CLI keeps its own token.

## OpenTelemetry logs

This Connector gives Monitor a second log source beside Datadog. It reads a Log folder: OTLP JSON lines that an OpenTelemetry Collector's `file` exporter writes on your Mac. There is no sign-in. Press Choose folder in Integrations to open the macOS folder dialog, the one the Repos page uses. The pane shows the path you chose, and Connect starts reading. The Connector reads connected when the folder exists and the console can read it. A folder with no `.json` or `.jsonl` files connects, and its Scan says no files were found.

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

1. Choose the Profile. The picker lists the AWS profiles on this Mac, with `default` first. When none exists, the picker is empty and Connect creates `default` through the sign-in.
2. Choose the Region, such as `us-east-1`. It starts as the profile's region when the profile has one.
3. Press Connect. The console runs the AWS CLI's browser sign-in for the profile: `aws sso login` when the profile has an Identity Center session, `aws login` when it has none. Cancel stops the wait. The Connector reads connected when the AWS CLI answers for the profile, and needs auth when it does not. A profile that is already signed in connects at once.
4. Pick Log groups from the list the profile can see. Each picked group is one Service. Its Service name starts as the last path segment of the group, so `/ecs/shop-api` becomes `shop-api`, and its env starts as `prod`. You can edit both. Two groups with the same Service name and env are refused.

`aws login` needs AWS CLI 2.32.0 or later. With an older CLI, Connect stops, names the installed version and the command that updates it, `brew upgrade awscli`. The console updates nothing.

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

This Connector gives Monitor a fourth log source. It reads the logs of a Loki data source in a Grafana Cloud stack, through Grafana's hosted MCP server. It reads Grafana Cloud's Loki only: a self-hosted Loki is not read.

Connect it in Integrations:

1. Press Connect. The console opens Grafana's sign-in in your browser. The console signs in itself and keeps its token in the macOS Keychain. The browser comes back to a page on your Mac that closes after one use.
2. Finish the sign-in in the browser. When the stack has one Loki data source, the Connector uses it. When it has several, the pane shows a picker with their names, and Connect finishes when you pick one. A stack with no Loki data source says so, and the Connector stays at needs auth with Reconnect.
3. Connect also registers Grafana's MCP server with Claude Code for the agent. Claude Code can open one more browser sign-in for it, usually one click.

A Connector that held a self-hosted URL reads needs auth with the note "Loki on Grafana Cloud only: the self-hosted URL is no longer read." until you press Reconnect and sign in to Grafana Cloud. Its Services, Alerts and Scans stay.

### Names

A Scan reads two labels, and you cannot change them:

| Field | Label |
| ----- | ----- |
| Service | `service_name` |
| Env | `deployment_environment_name`. A stream without it reads as `no env`. |

A source whose logs have no `service_name` label connects, and its Scan says it found no Services under that name. Each connected log source runs its own Scan schedule, with its own Check interval and daily scan time.

### What a Scan reads

The daemon calls Grafana's query tools itself, on the Connector's schedule, with the Connector's own token and no model turn. A Scan finds the Services from the values of the service label over the Scan's window. It then runs two queries for each Service. The first counts failing lines per 10-minute bucket. The second reads the newest failing lines as Samples, at most 5,000 per Service. Grafana's server returns 100 lines for each call, so the Scan pages through the window until it has 5,000 lines or reaches the end. When a Service has more, a Route with one message group takes its count and 10-minute peak from the first query, and a Route with several message groups counts the newest 5,000 lines read. The Scan's notes say so. A server that refuses to page, an answer the console cannot read, or an error the server returns fails the source with the server's words shown. A rate limit the server names fails it as rate limited.

### Log fields

The reader expects every log line to be JSON. For each field it takes the first name in the list that the parsed line has:

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

A line that does not parse has none of these fields and is not read as a failure. Plain-text logs and access logs are not read.

### Access for the console and the agent

The console reads logs and writes nothing to Loki, and a PROD env is read-only like any other. The console sends no write tool call to Grafana.

A Verification or a Fix of a Loki Alert starts with a Recheck that counts the Alert's failing lines for the last hour, and the Report's evidence section is headed "Log evidence". The agent's brief gives it the Samples. When it needs more logs, the agent reads them through the Grafana MCP server that Connect registered with Claude Code, as it reads Jira. The agent may call only the server's read tools: data sources, labels and log queries.

Alerts and Services from this source carry a Loki label in Monitor. Disconnect removes Grafana's MCP server from Claude Code's config and the console's token from the Keychain, and leaves Grafana untouched. The picked data source stays for the next Connect.

## New Relic logs

This Connector gives Monitor a fifth log source. It reads the logs in a New Relic account through New Relic's hosted MCP server, or through New Relic's own API with a User API key when your administrator has turned the MCP server off.

Connect it in Integrations:

1. Choose the Region above Connect: US, EU or JP. It starts as US and picks the address of New Relic's server.
2. Press Connect. The sign-in belongs to Claude Code: Connect registers New Relic's MCP server with Claude Code and opens its browser sign-in. The console does not sign in to New Relic itself. Before the browser opens, the pane says macOS may ask for your Mac's login password once, so the console can read the sign-in Claude Code stored. If you refuse the prompt, the Connector reads needs auth. If New Relic's page says your administrator has disabled access, a New Relic administrator must turn on New Relic MCP Server in Feature Control Manager; the console cannot change that setting.
3. When the sign-in finishes, the console lists the accounts it can read. With one account the Connector uses it. With several, the pane shows a picker, and Connect finishes when you pick one.

A Scan reads the token Claude Code stored, and never refreshes it. When a read fails because the token expired, the console asks Claude Code to reconnect that one server, with no model turn, and reads again. When that fails too, the row reads needs auth and the pane offers Reconnect.

### With a User API key instead

When New Relic's page says your administrator has disabled access to the MCP server, the sign-in above cannot work, and the console cannot change that setting. Use a key instead:

1. In New Relic, create a User API key (it starts with `NRAK-`) for a user that can read the account's logs. A dedicated user with a read-only role is the safest choice, because a User key reaches every account its user can open.
2. In the pane, choose the Region, then open "Use a User API key instead" under Connect. Paste the key in the one field and press Connect with key.
3. The console checks the key by listing the accounts it can read. A key New Relic refuses is not stored, and the pane says why. A good key goes to your Keychain, never to the database, a log or the browser, and the pane never shows it again. The account is picked as in step 3 above.

The daemon then calls New Relic's own API (NerdGraph) from your Mac, over HTTPS, with the key in a request header. The key route does not use New Relic's MCP server. New Relic's documentation ties the Feature Control Manager switches to that server and does not say they reach this API. If your organization blocks it anyway, New Relic refuses the key and the pane says so. Only one route is active at a time. Connecting with a key replaces the MCP sign-in and removes New Relic's MCP server from Claude Code's config. Pressing Connect for the sign-in replaces the key and deletes it from the Keychain. A key that New Relic later refuses reads needs auth, and you paste a new one.

Scans read the same way on either route: the same queries, the same fields, the same 5,000-event cap and 61-hour limit on counts.

### Names

A Scan reads two attributes, and you cannot change them:

| Field | Attribute |
| ----- | --------- |
| Service | `service.name` |
| Env | `environment`. An event without it reads as `no env`. |

A source whose logs have no `service.name` attribute connects, and its Scan says it found no Services under that name. One Connector reads one account. Each connected log source runs its own Scan schedule, with its own Check interval and daily scan time.

### What a Scan reads

The daemon calls New Relic's NRQL query tool itself, on the Connector's schedule, with the stored sign-in and no model turn. A Scan finds the Services from the distinct values of the service attribute on failing events over the Scan's window. It then runs two queries for each Service. The first counts failing events per 10-minute bucket. The second reads the newest failing events as Samples, at most 5,000 per Service. When a Service has more, a Route with one message group takes its count and 10-minute peak from the first query, and a Route with several message groups counts the newest 5,000 events read. A window longer than 61 hours counts only the newest 61 hours. The Scan's notes say so. A result the server cuts at its own row limit, an answer the console cannot read, or an error the server returns fails the source with the server's words shown. A rate limit the server names fails it as rate limited.

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

The console reads logs and writes nothing to New Relic, and a PROD env is read-only like any other. The console sends no write tool call to New Relic.

A Verification or a Fix of a New Relic Alert starts with a Recheck that counts the Alert's failing events for the last hour, and the Report's evidence section is headed "Log evidence". The agent's brief gives it the Samples. When it needs more logs, the agent reads them through the New Relic MCP server that Connect registered with Claude Code. The agent may call only the server's read tools: NRQL queries and the account list. On the key route there is no MCP server for the agent, and it never holds the key. It calls a tool of the console's own, `query_new_relic`, that takes NRQL text only and runs one read-only query for the picked account, with the key the daemon holds. The tool refuses anything that is not a `SELECT`, `FROM` or `SHOW` query, returns at most 200 rows, and runs with no Approval. Each call is a row in the Action Log.

Alerts and Services from this source carry a New Relic label in Monitor. Disconnect removes New Relic's MCP server from Claude Code's config, and your User API key from the Keychain if you used one, and leaves New Relic untouched. The Region and the picked account stay for the next Connect.

## Checks and Disconnect

The console checks each connected Connector in the background, and again when its last check is older than 10 minutes. A failing check shows why, and recovering shows too.

Disconnect stops the console using the service, deletes its token from your Keychain and, where the service allows it, takes the access back at the service. The Connector then reads off.

## MCP Servers and Connections

Integrations also lists MCP Servers, which give the agent tools such as Slack or a database. The console registers each one in every Claude account you use. They are separate from Connections, which are the databases the agent may query, each with an Environment and an Access Level.

## Integration commands

For the CLIs (`pup`, `gh`, `glab`, `bkt`, `slashdocs`), the agent asks the console to run a command through its `run_integration` tool. A read runs at once. A write needs your Approval, unless the Session is in full mode or you chose "Don't ask again this Session" for that CLI. Sign-in, tokens and merges are refused.
