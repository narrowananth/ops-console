# Quick start

From a fresh install to a first Session with the agent.

## 1. Install and open the console

Follow [Install and update](/docs/install/), then run `ops-console open`. The console opens in your browser, already signed in.

## 2. Add a Claude account

The agent runs on a Claude account. Open Accounts & Usage and add one: sign in in this browser, or by link if the Mac has no browser tab to spare. See [Claude accounts and CLIProxy](/docs/claude-accounts/). If you use CLIProxy, point the console at it instead.

## 3. Import a Repo

Open Repos and import a local git repository by its folder. Sessions run in a Repo, each in its own git worktree, so your checkout is never switched.

## 4. Start a Session

Open Workspace, pick the Repo and write the task. The Access mode decides what the agent may do without asking. Start with supervised if you want to see every edit and command before it happens. See [Sessions and Access modes](/docs/sessions/).

## 5. Connect your services

Open Integrations and connect the services you use: Datadog for Monitor, GitHub, GitLab or Bitbucket for pull requests, Jira for Tickets, and more. Each one signs in in your browser. See [Connectors](/docs/connectors/).

## 6. Watch a Service

Once Datadog is connected, Monitor shows each Service's health and its Alerts. Start a Verification on an Alert, review the Report, and confirm it to start a Fix. See [Monitor and Playbooks](/docs/monitor/).

## When something goes wrong

Run `ops-console status` to see whether the daemon is up, and `ops-console logs` to follow its log. The [issue tracker](https://github.com/narrowananth/ops-console/issues) is the place to report a problem.
