# Sample repo

**Status:** draft, on hold in the [roadmap](../roadmap.md). Nothing in it is built: no `ops-console sample` command, no `sample` folder and no `/docs/sample/` page.
**Design:** none: a CLI command and a docs page. Monitor and Workspace show the sample's Service, Alerts and pull request as they show any other.

## Problem

A new operator has installed the console and signed in to a Claude account, but has no production data, and perhaps no Datadog account, to watch. They cannot see the flow the console exists for: a failing Route, a Verification, a Review, a Fix and a pull request. Roadmap step 2 wants a first verified Alert without asking anyone.

## Behavior

1. `ops-console sample` makes a folder named `ops-console-sample` in the home folder: a small app with one failing Route and its tests, as a git repository with one commit on `main` and no `origin`. It prints the folder and the next steps.
2. `ops-console sample <folder>` makes it in that folder instead. A folder that exists and is not empty is left alone: the command says so and exits non-zero. Running it never changes a git config, never contacts GitHub and never writes outside the folder.
3. The first commit works on a Mac with no git identity configured.
4. The sample app has two failing Routes, with the logs a Scan reads:
   - `POST /orders` answers 500 on an order with no items, often enough in one 10-minute bucket to rank High. The code has the bug and no test reproduces it.
   - `GET /orders/:id` answers 404 for an id that does not exist, a few times. It ranks Low and the code is right.
5. The stand-in `pup` ships in the release, beside the sample, and answers the calls the console makes: `auth status` (signed in, org `sample`), `auth login` (succeeds at once), `logs aggregate` and `logs search`. It reads one fixture file. Log times in it are relative, so a Scan always finds them inside its window. `mcp --help` and every other `pup` command exit non-zero with a line saying the sample does not support it.
6. With the stand-in first on the PATH when `ops-console start` runs, the Datadog Connector reads connected. A Scan finds one Service, `ops-console-sample` in the env `sample`, and two Alerts: the `POST /orders` 500 as High and the `GET /orders/:id` 404 as Low, each with Samples.
7. The Service finds its code when the sample folder is an imported Repo of the same name. Under another name the operator links it by hand, as for any Service.
8. A Verification of the High Alert runs in a Scratch copy of the sample, from the default branch with "could not fetch" shown (no `origin` yet), and its Recheck reads the stand-in. The agent's own `pup` reads through `run_integration` get the same logs.
9. The operator can Review the Report, confirm it and run the Fix. The Fix commits in the sample. Pull request opening works once the operator has given the folder an `origin` on their own GitHub account and connected GitHub. The docs give the one `gh repo create` line for that. Before an `origin` exists, the Fix stage fails with the console's usual reason that origin is not on a Git host, and the operator can retry after adding it.
10. The Low Alert can be dismissed from its Report.
11. The stand-in only reads, and holds no PROD data. Nothing in the fixture, the sample app or the docs is a real service, hostname, account or person.
12. `ops-console stop`, then `ops-console start` with the PATH unchanged, goes back to the real `pup`. The sample's Service and Alerts stay in the database until the operator removes them.
13. Sessions and Scans of the sample behave as for any Service: two at once, a reload mid-stream and a failed run work as they do elsewhere. The sample adds no state of its own.
14. `/docs/sample/` exists, "Try it with a sample repo", after "Quick start" in the docs sidebar, with a link from "Quick start". It lists the steps: install, `ops-console sample`, import the folder as a Repo, `gh repo create` for an `origin`, start with the stand-in on the PATH, connect Datadog, Scan, Verify, Review, Fix, open the pull request, and go back to the real `pup`. It says to skip the sample while real Datadog data matters.
15. The site build still passes: every page builds, every internal link has a page, no page loads anything from a third party.

## Settled

- **Where it lives**: a `sample` folder in this repo, copied into the release. Not a separate template repo: `/ship` builds one repo, and a template drifts from the console.
- **Mock source**: a stand-in `pup` on the PATH. [ADR 0005](../adr/0005-claude-code-is-the-integration-layer.md) already makes CLIs the integration layer, so the console runs it as it runs `pup`, and so does the agent's `run_integration`. No daemon change, no demo mode.
- **Queries**: the stand-in filters the fixture by the parts of the console's queries it can read: service, env, status code, method and path. It ignores the window beyond "everything in the fixture is inside it".
- **Runs on**: the installed app and its data folder. No second port or data folder, and no change to `ops-console start`. The command `sample` prints the exact `start` line with the stand-in's folder on the PATH. `ops-console stop` comes first when the console already runs.
- **Names**: the Service, the sample folder and the Repo share the name `ops-console-sample`, so the CodeFinder links them with no operator step.
- **First commit**: made with a fixed identity (an `example.com` address) passed on that one command, so no git config is read or changed.
- **Stand-in runtime**: the Node the release carries, never the system Node.
- **Glossary**: Sample repo and Stand-in `pup`.
- **ADR**: none. The design follows ADR 0005 and 0003.

## Not required

- **Removing the sample's data.** The Service and Alerts stay until the operator removes them by hand. A `sample --remove` is a follow-up.
- **Isolation from a real setup.** A stand-in `pup` first on the PATH shadows the real one until the next plain `start`. The docs say so.
- **A sample for Datadog's other reads**, such as monitors and dashboards.
- **A mock for Git hosts.** The pull request goes to the operator's own GitHub.

## Safety

No change to what the agent may do. The stand-in answers reads only, and every other `pup` command fails. The Fix and the pull request follow the Playbook and [ADR 0002](../adr/0002-operator-approves-agent-never-merges.md): the operator confirms the Report, and the agent never merges.

## Rejected

- **A daemon demo mode that swaps the Datadog reader**: a new production code path, and the agent's own `pup` calls would still reach the real one.
- **Seeding Alerts into the database**: no Alert exists outside a Scan, and a Verification's Recheck needs a reader anyway.
- **A separate template repo**: out of reach of `/ship`, and it drifts from the console.
- **`ops-console sample` creating the GitHub repo**: it would write to the operator's GitHub account. That command is the operator's to run, as AGENTS.md says of anything that writes outside the machine.
- **A flag on `start` that prefixes the PATH**: changes the launchd job for a demo. The PATH prefix on one `start` line does the same with no new code.

## Glossary

- **Sample repo**: A small app with a known failing Route, made by `ops-console sample` as a git repository with no `origin`, for trying a Verification, Review, Fix and pull request without production data.
- **Stand-in `pup`**: The `pup` the release ships for the sample. It answers the console's and the agent's reads from a fixture file and fails every other command. The console runs it when it is first on the PATH of `ops-console start`.

## Seams

- **Backend + SQLite** (monitor tests, existing harness): 4 to 8, 11. The real Datadog reader and the real connector tools run against the stand-in file instead of a fake: the Connector reads connected, a Scan makes the Service and the two Alerts with their Severity and Samples, the Service links to a Repo of the same name, and a Recheck count reads the fixture. A call outside the four fails, and `mcp --help` fails.
- **CLI** (existing CLI test harness): 1 to 3 and 12. `ops-console sample` makes the repository with one commit and no `origin`, with and without a folder argument, leaves an existing non-empty folder alone, and works with no git identity. A plain `start` leaves the PATH as it is.
- **Node test** (site build test, existing): 14 and 15. The page's place in the docs order, the link from Quick start, and the existing link and third-party checks.
- **Read in review**: 9, 10 and 13 are the console's existing Verification, Review, Fix and pull request flows. The reviewer reads the docs steps against them.

## Out of scope

- The video walkthrough, the last item of roadmap step 2. It follows this one.
- `ops-console sample --remove` and a second data folder for demos.
- Linux and Windows. The stand-in and the command follow the macOS install.
