# Run network allowlist

**Status:** shipped
**Design:** none. Permissions page: gains one row that opens a list. Permissions already departs from the design.

## Problem

An agent run can read the checkout, the files the operator attached and the `GH_TOKEN` it carries. The network is open, so a run steered by a log line can send any of that to any host. The operator has no way to say which hosts a run may reach, and no way to see what a run was refused.

## Behavior

### What a run can reach

1. Every agent run's shell commands reach only the hosts on that run's allowlist: every Session kind, every Access mode (`full` included), every Playbook step turn and every chat turn. A command to any other host fails and the run goes on. The command's result in the transcript names the host, for example `deny network-outbound registry.example.com:443 (host is not on the allow list)`. A reload mid-run shows the same text.
2. A command cannot go around the filter. A direct connection to an IP address, a DNS lookup that skips the filter and UDP all fail. A client that ignores the proxy settings, such as Node's built-in `fetch`, fails even against an allowed host.
3. `WebFetch` and `WebSearch` are denied in every run, in every Access mode.
4. What the Playbooks run keeps working against allowed hosts: `git` clone and fetch over https, `gh` (signed in through `GH_TOKEN`), `pnpm` installs from the npm registry, and `curl`. MCP Servers and Connections are unchanged, and a PROD write still waits for an Approval in every Access mode.
5. When the Run sandbox is unavailable the run fails before its first command, as before. There is no mode with the network open.

### Where the list comes from

6. A run's allowlist is built when the run starts, from three groups: Built-in, From Repos and Added by you.
7. Built-in is `github.com`, `api.github.com`, `*.githubusercontent.com`, and the package registries a build or commit hook fetches from: `registry.npmjs.org`, `registry.yarnpkg.com`, `crates.io`, `*.crates.io`, `proxy.golang.org`, `sum.golang.org`, `repo.maven.apache.org`, `repo1.maven.org`, `plugins.gradle.org`, `services.gradle.org`, `downloads.gradle.org`, `pypi.org`, `files.pythonhosted.org`, `rubygems.org` and `index.rubygems.org`. Every run has them, whatever else is on the list. The operator cannot remove or change them.
8. From Repos is the host of the `origin` remote of each registered Repo, read from either form (`https://host/path` or `git@host:path`). A Repo with no `origin`, or one whose host does not parse or is not a valid domain, adds nothing. The console reads the remotes when a run starts and stores none.
9. Added by you is the operator's own list (Behavior 13 to 17).
10. A wildcard `*.example.com` covers subdomains only. `example.com` needs its own entry.
11. A run keeps the list it started with. A change to Added by you, or to the Repos, reaches the next run. A resumed conversation, a retried step and a run after a daemon restart build a new list when they start. Two runs started on either side of an edit can hold different lists.

### Permissions

12. Permissions shows a row, "Network allowlist: N domains", next to the Run sandbox row. N counts the distinct domains across the three groups. Opening the row shows Built-in, which holds the built-in hosts and the Repos' hosts without naming a Repo, and Added by you. Built-in is read-only. The row has no on/off control.
13. The operator adds a hostname such as `npm.example.com` or a wildcard such as `*.example.com`. The console trims it, lowercases it and saves it.
14. The console refuses, with a message and nothing saved: an empty value, a bare `*`, a wildcard over one label (`*.com`), a scheme (`https://…`), a path, a port, an IP address, a name over 253 characters and anything that is not a hostname.
15. A domain already in any group is accepted and changes nothing: no second row, the count stays.
16. The operator removes a domain from Added by you. A run in progress keeps it, and the next run does not have it.
17. Added by you survives a reload and a daemon restart. Another browser that already has the page open shows the change after a reload.
18. A run cannot change the list: it cannot read the data folder or call the console's API as the operator.
19. A dev build (`pnpm dev`) keeps its own list in its own data folder.

### What must not regress

20. The Run sandbox's file rules, the `GH_TOKEN` sign-in, the Keychain timeouts and the Approvals behave as before. A blocked command does not fail its job by itself.
21. A failed run whose result text mentions the sandbox shows that text as the Session's `last_error`, as before.

## Settled

- **Mechanism**: the SDK's `network.allowedDomains` with `network.strictAllowlist: true`, set in the Run sandbox rules. The console sets the list; the SDK runs the filtering proxy and keeps the profile. No hand-written Seatbelt rule, no DNS interception, no proxy in the daemon. Checked on this Mac with the real SDK sandbox: a host off the list fails, raw IPs and DNS outside the filter fail, `curl`, `gh`, `git` over https and `pnpm` pass through it.
- **List built per run**: from the three groups when the run starts. Repo hosts are not stored.
- **Repo remotes**: read from each Repo's `.git/config` when a run starts, with no `git` process, so a run's start waits on nothing. A Repo whose `.git` is a file (a worktree) adds nothing.
- **Wildcards**: the SDK's `*.host` matches subdomains and not the apex.
- **No off switch**: no Setting, no flag and no unfiltered retry, the same rule as the Run sandbox.
- **Blocked host in the UI**: the transcript only. No parser, event or table.
- **`WebFetch` and `WebSearch`**: denied next to the merge denials. The SDK does not filter in-process tools. `WebSearch` is the same kind of tool; it was read, not run.
- **Datadog**: no domain. `pup` does not run in a run's shell, and the Datadog MCP Server runs outside the sandbox.
- **Validation**: one Zod schema in `shared/`, used by the API and by the page.
- **Loopback**: `allowLocalBinding` stays unset.
- **`/sandbox/i` on a failed result**: stays as it is. Text with a blocked host in it shows as the failure reason.
- **ADR 0006**: the open-network consequence is replaced. The allowlist moves from the "A network allowlist" bullet in Considered Options into the decision.

## Not required

- **Data sent to an allowed host**: a steered run holding `GH_TOKEN` can still use `api.github.com` (`gh gist create`, a push to a repo it controls). The allowlist closes arbitrary hosts, not GitHub. Review flags code that tries to stop it with a domain rule.
- **`git push` over ssh**: ssh ignores the proxy and fails in the Run sandbox today, with or without this change. A Fix that pushes over https works through `GH_TOKEN`.
- **Node `fetch` and other clients that ignore proxy settings**: they fail before and after. The run env does not set `NODE_USE_ENV_PROXY`.
- **Local servers**: binding a port fails in the sandbox today and still does.
- **A list or alert of blocked hosts**: the operator reads the transcript and adds the host.
- **Live sync**: other open browsers show an edited list after a reload.
- **MCP Servers, the daemon and the Setup agent's terminal**: not sandboxed, so not filtered.

## Safety

The agent's reach shrinks. A run loses every host outside its allowlist, and loses `WebFetch` and `WebSearch`. It gains nothing. The operator's list can only be edited from the console; a run cannot read the token that calls the API. No new shell command is allowed, and no Approval is added or removed. ADR 0002 and ADR 0003 hold. The PROD-write rule and Access Levels are untouched.

## Database

```sql
CREATE TABLE network_domains (
  domain     TEXT PRIMARY KEY,  -- lowercase hostname, or `*.` and a hostname
  created_at TEXT NOT NULL      -- ISO 8601
);
```

No existing rows to migrate.

## API

### Common

Errors:

| Status | Error code | When |
| ------ | ---------- | ---- |
| 400 | `validation_failed` | The domain is empty, `*`, a wildcard over one label, an IP address or too long, or has a scheme, a path or a port |
| 404 | `not_found` | The domain is not in Added by you |

### `GET /network-allowlist`

```json
{
  "built_in": ["github.com", "api.github.com", "*.githubusercontent.com", "registry.npmjs.org"],
  "from_repos": [{ "domain": "gitlab.example.com", "repo": "billing-api" }],
  "added": ["npm.example.com"]
}
```

- `from_repos`: one entry per host, with the name of a Repo that has it. Read from the Repos' remotes when asked.
- `added`: the operator's domains, A to Z.

### `POST /network-allowlist/domains`

Request: `{ "domain": "npm.example.com" }`. Answers 201 with the saved `{ "domain": "…" }`, or 200 with the same body when the domain is already in any group. Errors: Common.

### `DELETE /network-allowlist/domains/:domain`

Answers 204. The name is trimmed and lowercased, as on add. Errors: Common.

## UI

Permissions: a row "Network allowlist: N domains" under Run sandbox, opening the three groups. Departs from the design, as Permissions already does.

- **Loading**: the row shows a placeholder count.
- **Error**: the row reads "Could not read the list" with a retry.
- **Empty**: Built-in always has four entries. Added by you shows "None added".
- **Added by you**: an input with an Add button, and a remove button on each domain. A refused value shows its message under the input and clears when the operator edits it. Help text: "`*.example.com` covers subdomains. Add `example.com` too if you need it."
- **PROD**: changes nothing here.

## Rejected

- **DNS interception or a daemon-side proxy**: the SDK already filters, and a second filter in the daemon is code to keep for the same result.
- **A hand-written Seatbelt network rule**: the console leaves the profile to the SDK (ADR 0006).
- **A list fixed in code only**: private registries and internal hosts differ per operator.
- **A Setting to turn the allowlist off**: the escape hatch is what the allowlist removes.
- **A blocked-host event and table**: the transcript already shows the host, and the operator acts on it there.
- **`allowLocalBinding` now**: widens the run's reach and is not part of closing exfiltration.

## Glossary

- **Network allowlist**: the hosts an agent run's commands may reach, built when the run starts from Built-in hosts, the hosts of the Repos' remotes and the operator's own domains. Any other host is refused.

## ADR

- **0006, Agent runs are sandboxed by the OS**: edit in place. The open-network consequence goes. Runs reach only the Network allowlist, filtered by the SDK. The open network joins Considered Options with why it lost: a steered run could send out what it can read, including the checkout and `GH_TOKEN`. The trade-off is a list the operator may need to extend, and `GH_TOKEN` can still be sent to GitHub.

## Seams

- **Run options** (backend + SQLite, Supertest, fake SDK that records its options; extend the Run sandbox test): 3, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21.
- **Real sandbox** (backend, macOS only; extend the real-sandbox test): 1, 2, 4. A host off the list fails with the violation text and the run goes on, a raw IP, a lookup, UDP and a client that ignores the proxy fail, and a host on the list passes through the proxy (a local stand-in server, `curl`). `git`, `gh` and `pnpm` over the proxy need the network and sign-ins, so they are checked by hand, not by a test.
- **Browser** (Playwright against the real daemon, which answers the Mac-only gates; a new spec): 12, 13, 14, 15, 16, 17.

## Out of scope

- A list of blocked hosts with an Add button on the Session. Own spec, if the transcript proves too slow.
- `allowLocalBinding`, so a Verification can start a local server. Own spec.
- Making Node's `fetch` use the proxy (`NODE_USE_ENV_PROXY=1`). Own spec.
- Which secrets besides `GH_TOKEN` a run's shell can read, such as the CLIProxy key. Not checked here; `/ship` looks and reports.
