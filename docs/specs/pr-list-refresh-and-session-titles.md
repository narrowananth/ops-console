# Pull request list refresh, Session titles and the Approval card

**Status:** shipped
**Design:** Workspace Pull requests tab and Session header; Approval card (`design/ops-console.html`, `.approval`).

## Problem

The pull request list read every Git host again each minute, so Bitbucket and GitHub rate limited the console and the
list showed "The Git host did not answer" over and over. A search could only filter what was kept, so a pull request
that was closed or past the list's page was never found. A Session was named for the first 60 characters of the
first message, attachment chips included. Its title was larger than the Repo name beside it. The Approval prompt was a
flat pink box.

## Behavior

1. The daemon keeps each list 30 minutes. An older list is served at once and read again behind the answer. Refresh
   reads at once. A read that failed is tried again after 5 minutes.
2. A search by words filters the kept list and asks no host. Under Mine it matches the number, the title and the
   Connector's `login`. Under All it matches the number, the title and the author. Branch is not searched.
3. A search of just a number, with or without `#`, asks every known project's host for that number and shows what it
   finds with the list's matches, under Mine and All. Only open pull requests show: a merged or closed one stays out. Each answer is kept 60 seconds. A host that fails or rate limits marks
   the result stale.
4. The search box waits 400 ms after the last key before sending. The previous list stays up meanwhile.
5. A new Session is named for its first task: the first sentence, with attachment chips, code blocks and openers such as
   "can you please" dropped, cut at a word within 52 characters. Attachments alone make "Attached files".
   When the first run ends, the name Claude Code gave the conversation (its `ai-title` transcript entry, such as
   "Hermes Atlas stores API response" for a pasted `curl`) replaces it, cut the same way. A Session the operator renamed
   meanwhile keeps their name, and later runs never rename it. With no `ai-title` within a few seconds the first
   sentence stays.
6. The Session title is the same size as the Repo name before it.
7. An Approval shows as a card: kind icon, "Approval needed", the kind, a PROD badge, the summary, the command in a
   mono block, then Approve and Deny.

## Not required

- **Fresh PR data between reads**: a pull request opened on the host appears at the next 30-minute read or Refresh.
- **Titles that follow the conversation**: the name is set after the first run and does not change as the task moves.
- **Renaming Sessions named before this**: they keep their first-sentence title until the operator renames them.
- **GitLab number search**: GitLab's pull requests open on GitLab and have no adapter lookup.
