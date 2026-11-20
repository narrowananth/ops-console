# Monitor and Playbooks

Monitor is where the agent starts from a failure and ends at a pull request, with you deciding in between.

## From log line to pull request

1. **Scan.** The console scans each Service's logs on a check interval, through Datadog, from an OpenTelemetry [Log folder](/docs/connectors/#opentelemetry-logs), from [CloudWatch Log groups](/docs/connectors/#cloudwatch-logs), from [Loki](/docs/connectors/#loki-logs) or from [New Relic](/docs/connectors/#new-relic-logs), and raises an Alert for each kind of failure. An Alert has a fingerprint, a severity and a route.
2. **Verification.** You start one. The agent tries to explain the Alert from the code, in a scratch copy: it follows the log through the code, replays the request, tests with mock data when it can, and cross-checks your Connections.
3. **Report.** The Verification ends in a Report: the steps, the replayed request and its result, the root cause and the proposed fix.
4. **Review.** You confirm the Report as a bug or an improvement, or dismiss it. A dismissal can be undone.
5. **Fix.** After you confirm, the agent works on a branch. By default that means a code change, mocked tests, the full test suite and a diff review. If Jira is connected and the Playbook asks for one, it makes a Ticket first.
6. **Pull request.** The console pushes the branch and opens the pull request. A merged pull request resolves the Alert. You merge it yourself.

An open Alert that no Scan has seen for 14 days is resolved by the console. A Verification works in a scratch copy at the newest commit of the branch your Playbook names, and the scratch copy is removed when the Report is ready.

## Playbooks

A Playbook holds the rules and ordered steps the agent follows when a Trigger starts it, the Skills it holds, the branches Verify and Fix read from, and whether a Fix makes a Ticket.

- **Triggers** are the places that start the agent: Verify and Fix in Monitor, and Review PR, Check reply, Address comments, Reply in thread and Session message in Workspace.
- **Built-in Playbooks** run until you attach your own. They are read-only. New Playbook gives you an editable copy.
- **Steps** can be marked scratch copy, so a step like running the tests happens away from your checkout.
- **Skills** are instructions the agent can load. The console ships built-in skills, and you can add your own or use a project's.

Whatever the Playbook, the console fetches origin before every run and tells the agent to work from the newest production branch.

## Agent runs

The Agent runs page lists each run with its health: where it is, why it is slow or ended, where its time went, and every call it made.
