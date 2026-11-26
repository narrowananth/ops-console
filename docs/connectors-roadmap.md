# Connectors roadmap

**Status:** draft, followed up one Connector at a time. Official documentation was read on 2026-11-26; nothing below has been run against the services.

The order in which new Connectors are built, shipped one at a time, each with a spec, tests and a release. Figma comes first,
then Notion, Shortcut and Render, then the rest by the stack in use. Figma is read only. Every other Connector supports
everything its vendor offers, reads and writes, with the writes asking first.

A Connector is for a service the console itself uses or that needs a one-click sign-in and a status. Any other MCP server can
already be added in Integrations without one, which is the route for local developer tools such as the Dart and Flutter server.

## Today

Sixteen Connectors: Datadog, Jira, GitHub, GitLab, Bitbucket, Slack, Sentry, Shopify, slashdocs, Google Docs, Google Sheets,
Google Drive and four log sources (OpenTelemetry, CloudWatch, Loki, New Relic). Jira's Atlassian server also reaches
Confluence. Database Connections cover Postgres, MongoDB, Redis, ClickHouse, Firebase and Kafka.

## The stack this plan assumes

Read from the console's own screens, not confirmed by the operator. Correct it and the order below changes.

- Java services on Spring, with actuator and Prometheus endpoints and Bruno API collections, so Postman is not in the stack.
- Bitbucket and Jira for code and tickets, Slack for alerts, Datadog and CloudWatch for logs, AWS (SSM parameters).
- Postgres, MongoDB, Redis, ClickHouse and Firebase databases.
- Android and iOS apps for Shopify stores, built from the same Repos, with Firebase behind them. Flutter is named by the operator.
- Figma for design.

## Rules for every item

1. One Connector per spec and per release. Order: spec, red test, build, run against the real service, pull request, version
   bump, release.
2. Figma is read only, by the operator's choice: its write tools depend on the plan and seat. Every other Connector offers
   all the tools its vendor's server or API offers.
3. Each spec sorts a Connector's tools into three classes. Read tools run. Write tools raise an Approval, as other writes to a
   service outside this Mac do, and `full` access skips it. Destructive tools always raise one, `full` included: deletes,
   production deploys and releases, and moving money. A tool the vendor adds later counts as destructive until the spec lists it.
4. Connector tools reach the operator's own chat runs only. Verify, Fix and pull request jobs keep their own tool set.
5. A sign-in that the vendor's client rules refuse leaves the Connector at `auth` with the reason. It is never worked around
   by borrowing another client's identity.
6. Secrets stay in the Keychain (ADR 0004). No token appears in a response, event or log.
7. The credential the operator gives must cover the writes. The Connector's pane names the permission to give (a key scope,
   a role), and a call the credential cannot make fails with the vendor's own message.
8. A vendor tool that can do anything by its arguments, such as AWS's `call_aws`, cannot be sorted by its name. Such a Connector
   starts read only, through the vendor's own switch, until a spec designs a classifier for its operations, as the console
   has one for SQL.

## Order

| Step | Connector | Why now | Route | Tools the agent gets |
| ---- | --------- | ------- | ----- | -------------------- |
| 0 | Tool classes | Every item sorts its tools into read, write and destructive | Console | The class decides run, ask or always ask |
| 1 | Figma | First request: design to code from Sessions | Hosted MCP | 20 read tools only |
| 2 | Notion | Requested: specs and docs in a Session | Hosted MCP | All tools: 21 read, 19 write found so far |
| 3 | Shortcut | Requested: stories and iterations | Console bridge on the REST API | Reads and writes on the main resources |
| 4 | Render | Requested: services, deploys, logs | Hosted MCP with an API key | All tools: 16 read, the rest write |
| 5 | Firebase tools | Crashlytics issues and events for the mobile apps | Local MCP (`firebase mcp`) | All tools, Remote Config publish destructive |
| 6 | Google Play | Crash and ANR rate, reviews, releases for Android | Console bridge, service account | Reads, review replies, release edits destructive |
| 7 | App Store Connect | Builds, TestFlight, reviews for iOS | Console bridge, API key | Reads, review replies, submission destructive |
| 8 | CI for the mobile apps | Failed builds: Bitrise or Codemagic, whichever is used | Bitrise MCP, or a bridge | All tools, build triggers and aborts write |
| 9 | PagerDuty | Incidents beside the Alerts, if PagerDuty is used | Hosted MCP | All tools, incident changes write |
| 10 | AWS | SSM, ECS and cost reads beyond CloudWatch | Local MCP, read-only IAM role | Read only until a classifier exists (rule 8) |
| 11 | Terraform | State and registry, if used | Hosted MCP with a token | All tools the remote server offers |
| 12 | Product and front end | PostHog, Linear, Vercel, Chromatic, Zeplin, Stripe, each on demand | Hosted or local MCP | All tools, money and deploys destructive |

Items 5 to 12 are proposals. Each needs a yes from the operator that the service is in use before its spec is written.

## 1. Figma

**Status:** built, read list and Connect. The sign-in against Figma and a real read are not yet run (the spike below).

Read only, every kind of read: files, frames, variables and styles, comments, FigJam, Code Connect mappings, libraries, and
images exported from a file. Nothing is written to Figma. Figma's write tools depend on the plan and seat, so the operator
chose reads only.

- Route: Figma's hosted MCP server at `https://mcp.figma.com/mcp`, HTTP. The desktop server (`http://127.0.0.1:3845/mcp`)
  needs the Figma desktop app with Dev Mode, has fewer tools, and is left out of the first release.
- Sign-in: OAuth with the operator's Figma account through Claude Code. Figma's documentation says only clients on its MCP
  catalog may connect and lists Claude Code. It does not say whether a client registers itself or needs a client id.
  The first task is a spike: sign in from the console and call `whoami`. If Figma refuses it, the fallback is a
  read-only bridge on the Figma REST API with the operator's token, which reaches files, nodes, images, comments and variables
  but not `get_design_context`.
- Read list (from the tools page): `get_design_context`, `get_screenshot`, `get_metadata`, `get_variable_defs`,
  `get_figjam`, `get_comments`, `get_code_connect_map`, `get_code_connect_suggestions`, `get_context_for_code_connect`,
  `get_libraries`, `search_design_system`, `get_motion_context`, `get_shader`, `list_shaders`, `list_file_shaders`,
  `get_generative_plugin`, `list_generative_plugins`, `download_assets`, `export_video`, `whoami`.
- Refused: `use_figma`, `generate_figma_design`, `html_to_figma`, `send_code_to_figma`, `upload_assets`,
  `add_code_connect_map`, `send_code_connect_mappings`, `create_new_file`, `generate_diagram`, `generate_image`,
  `generate_vector_illustration`, `create_generative_plugin`, `update_generative_plugin`, `create_shader`, `update_shader`,
  and any tool not on the read list.
- Limits Figma sets: Dev and Full seats on Professional get 200 calls a day and 10 a minute, Organization 200 and 15,
  Enterprise 600 and 20. View and Collab seats get 20 a month. Starter plans get none. The pane says so.
- Spec: [figma-connector](specs/figma-connector.md).
- Documentation:
  - [Guide to the Figma MCP server](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server)
  - [Figma MCP server developer docs](https://developers.figma.com/docs/figma-mcp-server/) (remote setup, tools, rate limits)
  - [MCP catalog](https://www.figma.com/mcp-catalog)
  - [REST API](https://developers.figma.com/docs/rest-api/) and its scopes page, for the fallback

## 2. Notion

- Route: hosted MCP at `https://mcp.notion.com/mcp`, Streamable HTTP. The older `/sse` address retires on 2027-02-23.
  The open-source local server is no longer maintained.
- Sign-in: OAuth with PKCE, and dynamic client registration works, so it signs in as Sentry does. A workspace owner can
  also create an MCP token on Business and Enterprise plans.
- Read-only mode: none. Actions run with the user's permissions, so the console's classes decide what asks.
- Read tools: `notion-search`, `notion-fetch`, `notion-connector-search`, `notion-list-private-pages`,
  `notion-list-shared-pages`, `notion-list-favorite-pages`, `notion-list-recent-pages`, `notion-list-page-backlinks`,
  `notion-query-meeting-notes`, `notion-query-data-sources`, `notion-query-multiple-data-sources`, `notion-get-comments`,
  `notion-get-version-changes`, `notion-view-version`, `notion-get-suggested-edit`, `notion-get-async-task`,
  `notion-get-self`, `notion-get-teams`, `notion-get-groups`, `notion-get-users`, `notion-get-tool-access`.
- Write tools (ask): `notion-create-pages`, `notion-update-page`, `notion-move-pages`, `notion-duplicate-page`,
  `notion-create-database`, `notion-update-data-source`, `notion-create-view`, `notion-update-view`,
  `notion-create-comment`, `notion-update-comment`, `notion-set-discussion-resolved`, `notion-set-comment-reaction`,
  `notion-create-suggested-edit`, `notion-resolve-suggested-edit`, `notion-restore-version`, `notion-restore-pages`.
- Destructive (always ask): `notion-delete-pages`, `notion-delete-databases`, `notion-delete-comment`. Notion's
  page deletion moves content to Trash.
  Not yet read in the documentation: files, skills and agents, calendars. They count as destructive until read and listed.
- Limits: 180 requests a minute per connection, 600 on Business and Enterprise.
- Documentation:
  - [Get started with the Notion MCP server](https://developers.notion.com/docs/get-started-with-mcp)
  - [Supported tools](https://developers.notion.com/guides/mcp/mcp-supported-tools)
  - [Building an MCP client (OAuth details)](https://developers.notion.com/guides/mcp/build-mcp-client)
  - [Request limits](https://developers.notion.com/reference/request-limits)
  - [REST API](https://developers.notion.com/reference/intro)

## 3. Shortcut

- Route: a console bridge on the Shortcut REST API v3, as the Google Connectors do. Shortcut's official MCP server
  repository is archived and read-only since 2026-07-08, and no hosted server turned up in the documentation read (the
  site was not searched, so a hosted one is not ruled out). Run the check again before the spec.
- Sign-in: an API token the operator creates in Shortcut settings, kept in the Keychain and sent in the
  `Shortcut-Token` header. Shortcut tokens have full account access, with no read-only scope. The bridge exposes only
  GET calls and the writes of the main resources: stories, epics, iterations, workflows, members, comments, labels and search.
  The bridge's own tools are the classes: reads run, create and update ask, delete always asks. The token's full access
  means the bridge is the only guard, so it exposes no call that is not in its tool list.
- Limits: 200 requests a minute.
- Documentation:
  - [Shortcut REST API v3](https://developer.shortcut.com)
  - [Create an API token](https://app.shortcut.com/settings/account/api-tokens)
  - [Archived MCP server repository](https://github.com/useshortcut/mcp-server-shortcut)

## 4. Render

- Route: hosted MCP at `https://mcp.render.com/mcp`, Streamable HTTP, with an API key sent as a bearer token.
- Sign-in: an API key from the Render dashboard. Its "Read only" option grants Read on every resource, so the key is
  limited at the source, but the full set of tools needs a key with Read and write, plus Run for deploys. Render documents
  OAuth only through its own plugins.
- Read tools: `list_workspaces`, `get_selected_workspace`, `select_workspace` (a choice held by the session, nothing
  stored at Render), `list_services`, `get_service`, `list_deploys`, `get_deploy`, `list_events`, `list_logs`,
  `list_log_label_values`, `get_metrics`, `list_postgres_instances`, `get_postgres`, `list_key_value`, `get_key_value`,
  `get_blueprint`.
- Write tools (ask): `create_web_service`, `create_static_site`, `create_cron_job`, `create_postgres`, `create_key_value`,
  `update_environment_variables`, `run_cron_job`, `cancel_cron_job_run`, `create_blueprint`, `plan_blueprint`,
  `update_blueprint`. `query_render_postgres` runs read-only SQL against a database and asks, as the console treats a
  query on a Connection.
- Destructive (always ask): `trigger_deploy` and `approve_blueprint`, which change running services. The spec checks
  whether Render marks a service as production before relying on that line.
- Limits: none stated.
- Documentation:
  - [Render MCP server](https://render.com/docs/mcp-server)
  - [API keys and permissions](https://render.com/docs/api-keys)
  - [REST API](https://render.com/docs/api)
  - [Server repository and tool list](https://github.com/render-oss/render-mcp-server)

## 5. Firebase tools (Crashlytics)

- Route: Firebase's local MCP server, `npx -y firebase-tools@latest mcp`, using the same login as the Firebase CLI.
- Read-only mode: none. The classes decide what asks: `crashlytics_update_issue` and `crashlytics_create_note` write,
  `crashlytics_delete_note` and `remoteconfig_update_template` are destructive, because a Remote Config publish changes
  every installed app.
- Read tools: `crashlytics_get_issue`, `crashlytics_list_events`, `crashlytics_get_report`,
  `crashlytics_batch_get_events`, `crashlytics_list_notes`, `remoteconfig_get_template`, `auth_get_users`,
  `firestore_get_document`, `firestore_query_collection`. The Firestore and Auth tools read data of the Firebase
  Connections, so the spec decides whether they belong here or stay with those Connections.
- Documentation: [Firebase MCP server](https://firebase.google.com/docs/ai-assistance/mcp-server)

## 6. Google Play reporting

- Route: a console bridge on the Play Developer Reporting API (crash rate, ANR rate) and the Publishing API (reviews,
  tracks), with a service account invited to the Play Console with read permissions.
- Not found in the pages read: the OAuth scope URL and the reporting API host. Both are read before the spec.
- Tools: reads (crash rate, ANR rate, reviews, tracks), a review reply as a write, and release or track edits as
  destructive, since a production release reaches every user.
- Facts read: the reviews API returns only reviews with comments, from production versions, from the last week. Review
  reads allow 200 per hour per app.
- Documentation:
  - [Publishing API, getting started](https://developers.google.com/android-publisher/getting_started)
  - [Reporting API overview](https://developers.google.com/play/developer/reporting/overview)
  - [Metric sets](https://developers.google.com/play/developer/reporting/metricset-intro)

## 7. App Store Connect

- Route: a console bridge on the App Store Connect API, with an API key and a signed token.
- Tools: reads, a review response as a write, and a submission for review or a release as destructive.
- Not verified: Apple's documentation pages did not load in the research (they render in the browser), so the key
  roles, the endpoints for builds, TestFlight and reviews, and the token rules are all unread. No Apple-shipped
  App Store Connect MCP server was found, which a site search could still change. Read these pages by hand before the spec.
- Documentation: [App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi)

## 8. CI for the mobile apps

Pick the one the team uses, or neither.

- Bitrise: an official MCP server at `mcp.bitrise.io` with OAuth or a personal access token. Its page names Claude Code
  as a client. All its tools are offered; a build trigger or abort is a write. The tool list and any read-only option are in its repository,
  which was not read. [MCP page](https://docs.bitrise.io/bitrise-platform/ai/bitrise-mcp.md),
  [API](https://docs.bitrise.io/en/api.html)
- Codemagic: a REST API with a personal token in the `x-auth-token` header. No MCP server found, so a bridge on the
  build reads. [REST API](https://docs.codemagic.io/rest-api/codemagic-rest-api/)

## 9. PagerDuty

- Route: hosted MCP at `https://mcp.pagerduty.com/mcp` (US) or `https://mcp.eu.pagerduty.com/mcp` (EU).
- Sign-in: OAuth 2.1 without dynamic client registration. A client identified by a metadata document, which Claude Code
  is after a PagerDuty admin installs its app, or the operator's own OAuth app.
- Tools: all groups. `browse_*` tools read, `manage_incidents` and the other `manage_*` tools write. The URL option
  `?tool_groups=read-only-tools` stays available for an operator who wants a read-only PagerDuty. The `ai-agents` group needs
  PagerDuty Advance.
- Documentation: [PagerDuty MCP server](https://docs.pagerduty.com/ai-automation/advance/pagerduty-mcp-server)

## 10. AWS read

- Route: AWS Labs' API server (`awslabs.aws-api-mcp-server`) run with `READ_OPERATIONS_ONLY=true` and a read-only IAM
  role. Its one tool, `call_aws`, runs any AWS CLI command, so its name cannot say read from write (rule 8). Writes wait for a
  classifier of AWS operations. Its page says an official AWS-managed server supersedes it, so the spec picks between them after reading the
  managed server's endpoint and read-only setting, which its page does not state.
- Documentation:
  - [AWS MCP servers index](https://awslabs.github.io/mcp/)
  - [API server](https://awslabs.github.io/mcp/servers/aws-api-mcp-server)
  - [AWS-managed server](https://docs.aws.amazon.com/agent-toolkit/latest/userguide/mcp-server.html)

## 11. Terraform

- Tools: all the remote server offers. It already leaves out its destructive tools (`delete_workspace_safely`,
  `force_unlock_workspace`, `delete_project`, `delete_team`, `action_run`), and the rest follows the token's permissions.
- Route: HashiCorp's remote MCP server at `https://mcp.terraform.io/mcp`, in beta, with an HCP Terraform API token.
  It has no read-only mode and no OAuth. It does not support Terraform Enterprise. Claude Code is not among its documented
  clients.
- Documentation: [Terraform MCP server](https://developer.hashicorp.com/terraform/mcp-server)

## 12. Product and front end

On demand, each after a yes. Each offers all its tools under the classes of rule 3.

- PostHog: hosted MCP, OAuth or a personal key, `?readonly=true` removes write tools, 480 requests a minute.
  [Docs](https://posthog.com/docs/model-context-protocol)
- Linear: hosted MCP with dynamic client registration and a read-only address,
  `https://mcp.linear.app/mcp/readonly`. Low priority while Jira is the ticket system.
  [Docs](https://linear.app/docs/mcp)
- Vercel: hosted MCP at `https://mcp.vercel.com`, OAuth, only for clients Vercel has approved.
  [Docs](https://vercel.com/docs/mcp)
- Chromatic: hosted MCP at `https://mcp.chromatic.com/mcp`, mostly read tools, one write tool, `chromatic_mutate`.
  [Docs](https://www.chromatic.com/docs/mcp)
- Zeplin: a local server with a personal token, read data only. [Docs](https://support.zeplin.io/en/articles/11559086-zeplin-mcp-server)
- Stripe: hosted MCP, OAuth or an agent key. Its `send_money`, `transfer_money` and `convert_currency` tools are
  destructive. Stripe stops accepting restricted API keys for MCP on 2027-01-11, and has no
  read-only server mode, only separate read and write tools. [Docs](https://docs.stripe.com/mcp)

## Not planned

- Postman: the stack uses Bruno, and Postman's MCP page returned 404.
- Miro: its MCP page returned 404 and no replacement was found.
- Kubernetes: no official MCP server turned up in the research.
- Storybook's MCP addon: its documentation page returned 404, and it runs locally for development.
- Dart and Flutter MCP server: it is a local developer tool with no sign-in. Add it as an MCP server in Integrations
  ([docs](https://docs.flutter.dev/ai/mcp-server)).
- Fastlane: a local CLI the agent can run in a Session, not a service to sign in to.

## What each item needs from the operator

A sign-in in their own browser for Figma, Notion, PagerDuty and Render if OAuth is used; an API token for Shortcut, Render,
Terraform and Zeplin; a service account for Google Play; an App Store Connect key for the iOS reads. The console cannot create
any of these, and none is requested until that item's turn.
