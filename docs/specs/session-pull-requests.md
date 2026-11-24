# Pull requests of a Session

**Status:** shipped
**Design:** Session panel in `design/ops-console-sidebar.html`. Departure: under the branch picker the panel lists every pull request the Session opened, with a "Show N more" row, where the design shows one.

## Problem

A Session remembers one pull request. The agent can open a pull request on another branch of the same Repo, and the second one replaces the first in the Session's record, so the operator sees one pull request and loses the other. A Session that opens a pull request, merges it and carries on with a follow-up branch has the same trouble.

## Behavior

1. A `repo` Session keeps a list of the pull requests the console opened for it: those the agent asked for and those the operator opened with the Create PR step of the Commit, push & PR row. Each entry holds the number, the URL and the branch it came from.
2. A pull request opened on a branch of the Session's Repo joins the list and leaves the others in it. Opening the same pull request again, from a retry, a second browser or a Fix retry, leaves one entry.
3. The list survives a reload and a restart of the console. Deleting the Session deletes its list.
4. A pull request that only appears in the conversation is not in the list. An open pull request the Git host lists for the Session's own branch shows as the first row even when the console did not open it, as the single row always showed it. It is not recorded.
5. The Session panel shows the list under the branch picker, newest first. Each row shows the title, a link to the pull request in the Workspace's Pull requests tab, a link to the Git host, its state (open, merged or closed) and the CI checks mark. The first three rows show, and a "Show N more" row opens the rest and a "Show less" row folds them again.
6. Title, state and checks come from the Git host list the Repo's Pull requests tab reads. A pull request that list does not return shows its number and link only.
7. The row for the pull request of the branch the Session is on is the one the Session header's link shows, as before. A Session on a branch with no pull request of its own shows the header as before.
8. A Session with no opened pull request and no open one on its own branch shows no list. A `pr_review`, `anonymous` or `devtools` Session shows none.
9. After the update, a Session that remembered a pull request has it as the only entry of its list, and a Session that remembered none has an empty list. Nothing else about a Session changes.
10. A Session list read when the Git host list is down or rate limited still shows the numbers and links, with no title, state or checks.

## Settled

- **Membership**: the pull requests the console opened through the Session, and the open one of its own branch on the Git host, which the row showed before. The conversation is not read to find more.
- **Scope**: one Repo, the Session's own. Other Repos opened to the Session open no pull request through the console today, and stay out.
- **Order**: newest first, by the time the console recorded it.
- **Identity**: a Session holds one entry per number.
- **API**: `Session.pull_requests` is added beside `pull_request`, which keeps meaning the pull request of the branch the Session is on.
- **Migration**: the three `opened_pr_*` columns move into the new table and are dropped.

## Not required

- **Pull requests merged or closed from outside the console** change their row's state at the next read of the Git host list, not at once.
- **A pull request opened on a Repo opened to the Session.** The console opens none today.
- **Finding pull requests the Session's branch had before the console recorded them.** Only those from the update on are listed, and the one remembered before.

## Safety

No change. The list is read only, and the agent's reach is the same as before.

## Database

```sql
CREATE TABLE session_pull_requests (
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  number integer NOT NULL,
  url text NOT NULL,
  -- the branch the pull request came from
  branch text NOT NULL,
  -- when the console recorded it; the list is newest first
  created_at text NOT NULL,
  PRIMARY KEY (session_id, number)
);
ALTER TABLE sessions DROP COLUMN opened_pr_number;
ALTER TABLE sessions DROP COLUMN opened_pr_url;
ALTER TABLE sessions DROP COLUMN opened_pr_branch;
```

Before the columns drop, every Session row with a number, a URL and a branch gets one row in the new table, stamped with the Session's creation time.

## API

### `GET /sessions` and `GET /sessions/:id`

The Session body gains `pull_requests`, newest first:

```json
{
  "pull_requests": [{ "number": 41, "url": "https://github.com/acme/orders-api/pull/41", "branch": "fix-retry" }]
}
```

`pull_request` is unchanged: the pull request of the branch the Session is on now, or null.

## UI

- **Session panel**: the list under the branch picker, in the rows of the existing pull request row. States: no pull request (no list), one (one row, as before), more than three (three rows and "Show N more"), the Git host list loading (numbers and links only), down or rate limited (the same).
- **Sessions list**: a row with pull requests shows a mark in its third line, the number for one or `+N` for several, coloured by the newest one's state. The row's hover card lists each with its number and title, coloured the same.
- No PROD-specific state.

## Rejected

- **Reading every pull request of the Session's branch from the Git host**: it lists every pull request ever opened on the branch, others' included. Only the open one of the current branch is read from the host, as before.
- **A JSON column on the Session row**: one writer at a time today, but a list that two retries append to is a race in a read-modify-write, and a table with a key per number makes the second write a no-op.
- **Replacing `pull_request` with the list**: the spawned Session's card and the header read it, so a second name would only move their work.

## Glossary

- **Session pull requests**: The pull requests the console opened for a Session, kept as a list that the Session panel shows. It does not hold a pull request that only the conversation names, or one someone else opened.

## Seams

- **Backend + SQLite** (pull request opening tests, a fake Git host): 1 to 4, 9. Opening a second pull request on another branch keeps the first, a retry leaves one entry, the list is newest first and survives a restart, a Session delete removes it, a `pr_review` and an `anonymous` Session have none, and the migration of a remembered pull request.
- **Browser** (Playwright e2e): 5 to 8 and 10. The list under the branch picker, "Show N more" and "Show less", the title, state and checks of a row, a row the Git host list lacks, the header link for the current branch, no list for none, and the Git host list failing.
- **Read in review**: nothing else.

## Out of scope

- Opening pull requests in Repos opened to the Session.
- Finding pull requests the console did not open.
- Merging or closing a pull request from the panel.
