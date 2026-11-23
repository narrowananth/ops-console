# Data flow in the privacy policy and docs

**Status:** shipped
**Design:** none: text on the existing privacy page and one new docs page, in the site's current layout.

## Problem

An operator deciding whether to install Ops Console wants to know where their data goes before they connect anything. The privacy policy has a table of what leaves the Mac, but no page says in one place what stays on the Mac, what the agent sends to Anthropic's API, what each Connector sees, and that none of it reaches a server the project runs. [ADR 0003](../adr/0003-local-only-server.md) already guarantees the local-only part, so the work is writing it down.

## Behavior

1. `PRIVACY.md` has a `Data flow` section before `What leaves your Mac`. It names three parties: the operator's Mac, Anthropic's API and the Connectors. It says what stays on the Mac, what leaves and why, and that none of it reaches an Ops Console server.
2. The section names the one request that goes to a host the project controls: the update check, which asks GitHub for the latest release, and the download of an update. It says the app never calls opsconsole.org.
3. The section links the data-flow docs page by its full `https://opsconsole.org/docs/data-flow/` address, so the link works on GitHub and on the site.
4. `/privacy/` shows the same section, built from `PRIVACY.md`. The repo and the site hold one text.
5. `/docs/data-flow/` exists. The docs sidebar lists it after "Claude accounts and CLIProxy" and before "Safety".
6. The page draws the line by who calls the service. The console's own fixed calls (Scan, Health check, pull request list, Recheck, Pull request opening) go from the daemon to the service with no model turn, and their results stay on the Mac. A call the agent makes (an MCP Server tool, `run_integration` output, a file it reads) sends its result on to Anthropic's API as part of the run. A command a run executes goes from the Mac to the host it names, since the Run sandbox does not limit hosts, and its output goes to the agent and on to Anthropic's API. A page in a Session's Chrome and a Terminals process call what they call as the operator's own browser and shell do, with no model in between.
7. The page says stored Samples and Reports reach Anthropic only when a Verification or Fix puts them in a prompt, and that this holds for the records of a Log folder too.
8. The page groups Connectors by route and says for each group who calls the service and where the result goes:
   - CLI Connectors the daemon calls: Datadog, GitHub, GitLab, Bitbucket and slashdocs.
   - Hosted MCP servers: Loki logs through Grafana Cloud with the console's own sign-in, and New Relic logs with the sign-in Claude Code stored or, on the key route, New Relic's API called with a key in the Keychain and a console tool for the agent.
   - MCP Connectors Claude Code calls: Jira, Slack, Sentry, Shopify, GitHub, Datadog and Bitbucket through Atlassian.
   - The Log folder (OpenTelemetry logs): read on the Mac, no service called.
   - The AWS CLI and CloudWatch MCP server (CloudWatch logs).
   - The Google bridge: Google Docs, Sheets and Drive. The agent never sees the refresh token.
9. With CLIProxy as the Claude account hub, the page says prompts go to a CLIProxy server on the Mac and from there to the providers the operator configured. Without it, they go to Anthropic's API under the active Claude account.
10. The page says Claude Code, which the console runs, has its own traffic to Anthropic and its own settings under Anthropic's terms. The console sets no opt-out for it and makes no promise about it.
11. The page says rows read from a PROD Connection are part of what goes to Anthropic's API, and points to Access Level as the control.
12. The Safety page and the home page each link to the data-flow page once.
13. `PRIVACY.md` keeps `What leaves your Mac`, `Google data` and `Your control` as they are. The effective date moves to the day this ships.
14. The site build still passes: every page builds, every internal link has a page, no page loads anything from a third party, and `/privacy/` does not show the text `PRIVACY.md`.

## Settled

- **Placement**: the summary lives in `PRIVACY.md`; per-route detail lives on the docs page. The existing table is not repeated or edited.
- **Form**: tables and short prose. No picture, no text diagram, no change to the Markdown converter.
- **Grouping**: by route, not one row per Connector, so adding a Connector does not need an edit unless it opens a new route.
- **Anthropic**: named for the console's own Claude accounts. For CLIProxy the text says "the providers you configured", as the policy does today.
- **Glossary**: no new term. The text uses Connector, Claude account hub, Scan, Health check, Recheck, Verification, Fix, Sample, Report, Access Level and PROD as defined.
- **Link from `PRIVACY.md`**: a full URL, because a site-relative path breaks on GitHub.
- **Roadmap**: `/ship` adds `Spec: [data-flow-docs](specs/data-flow-docs.md)` to the matching item in `docs/roadmap.md`.

## Not required

- **A test that keeps the claim true in code.** No source scan for `opsconsole.org` or other hosts. The test pins pages and links only; review catches a code change that adds a project server.

## Safety

No change.

## Rejected

- **Privacy section only, no docs page**: the by-route detail would make the policy long, and the policy is the text Google reads.
- **Docs page only**: the privacy policy would no longer state the flow itself.
- **Fenced text diagram or SVG**: the first wraps badly on a narrow screen, the second needs image support in the site build. Both are more than a documentation item needs.
- **One row per Connector**: exact, but it drifts whenever a Connector is added.
- **Opt-out env vars for Claude Code's own traffic**: a code change with its own trade-offs, so a separate spec.

## Seams

- **Node test** (site build test, existing): 1 to 14. It builds the site and checks that `PRIVACY.md` holds the `Data flow` section with the full docs URL, that `/privacy/` and `/docs/data-flow/` build, that the sidebar order is right, that the Safety page, the home page and the privacy page link the docs page, and that the existing link and third-party checks pass. The wording itself is read in review.

## Out of scope

- Google OAuth verification and release signing. Both are on hold; they stay in `docs/roadmap.md` step 1.
- Opt-outs for Claude Code's own traffic.
- Roadmap steps 2 to 6.
