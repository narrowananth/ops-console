# Send an output file

**Status:** draft
**Design:** none. The Approval card is the existing one.

## Problem

The agent writes an Output file and the operator tells it where the file should go: a Slack channel, a branch in a Repo,
an S3 bucket, a URL. The Run sandbox blocks the network except the allowlist and hides the operator's cloud sign-in, so
the agent can only print a command for the operator to run. `save_file` reaches local folders only.

## Behavior

1. The operator names a destination in a message, such as "post the report in #ops-reports" or "upload it to
   s3://example-bucket/reports/". The agent calls the console's `send_file` tool with the file's name from the
   Session's output folder and one destination.
2. A destination is one of four kinds. **Slack**: a channel or a person, in a Workspace the Slack Connector is signed in
   to. **Repo**: a path on a branch of an imported Repo. **S3**: an `s3://bucket/key` address. **URL**: an `https://`
   address that takes the bytes in a `PUT`.
3. The tool raises an Approval in every Access mode. It shows the file, its size, the kind and the exact destination: the
   channel with its Workspace, the Repo, branch and path, the full S3 address, the full URL. Only the operator's yes
   sends.
4. On a yes, the daemon, outside the Run sandbox, sends the file as the operator and the tool answers with where it went:
   a Slack message link, the commit, the S3 address, the URL's status. The Output file stays in the output folder.
5. On a no, nothing is sent and the tool tells the agent it was denied. The agent does not retry another way, such as
   a command, and does not ask the operator to run one.
6. **Slack** uploads the file to the channel through the Slack Connector's sign-in, with the message text the agent gave.
   A channel the Connector cannot see, or a Connector that is not connected, is refused before any Approval.
7. **Repo** commits the file at the path on the branch and pushes it, as pull request opening does: the operator's git
   keys, never with force. A branch that moved, the default branch, and a Repo with no `origin` on a supported Git host are
   refused before the Approval. The path stays inside the Repo.
8. **S3** copies with the operator's own AWS sign-in on this Mac, which the sandbox hides from the run. No `aws` command
   or no sign-in gives the agent an error and no Approval. The Approval for an S3 address marks it as a write to cloud
   storage.
9. **URL** sends the bytes in a `PUT` with `Content-Type` from the file's name, and no header the operator did not see.
   Only `https://`. The daemon follows no redirect. A 2xx is sent; any other status is a failure with the status shown.
10. Anything refused before the Approval (unknown file, bad address, missing sign-in, unsupported host) gives the agent a
    specific error and raises no card.
11. A name not in the output folder, a path, `..` or a symlink is refused, as for `save_file`.
12. A send that fails after a yes tells the agent why. Nothing is retried on its own; a Slack message that posted before
    the failure stays posted.
13. The Approval waits like any other: the run shows Waiting for approval, the Agent runs page counts it under needs you,
    a reload keeps it, and Stop expires it.
14. A run the operator started offers `send_file` and `save_file` together. A job the console starts, a review of
    pull request text and a thread answer offer neither.
15. Each send writes an Action Log row before it runs, with the kind and destination and never the file's bytes.

## Settled

- **Who sends**: the daemon, outside the sandbox, as `save_file` and pull request opening do. The sandbox's write list and
  Network allowlist do not grow, and no credential reaches the run.
- **Approval every time**: no shortcut when the operator's message names the destination. Text injected through a log can
  name one too, and the daemon cannot tell the two apart.
- **One tool**: `send_file` takes a tagged destination, so the agent has one way to send and the Approval one shape.
- **Name**: the file's own name is the Slack file name, the last part of the S3 key when the address ends in `/`, and the
  Repo path when it ends in `/`.
- **S3 and the AWS CLI**: the daemon runs the operator's `aws` with an argument array. The console stores no AWS key.
- **Slack bytes**: the file goes up through the Connector, not a link to a path on this Mac.

## Not required

- **Download from a destination** back into the console.
- **A size limit** of the console's own. The card shows the size; Slack and S3 apply theirs and the error comes back.
- **Other clouds** (GCS, Azure) and **other chat apps**.
- **A progress bar.** The tool answers when the send ends.
- **Sending a file that is not an Output file.**

## Safety

The agent gains one tool, `send_file`. It writes and sends nothing itself: only the daemon sends, only after the
operator's yes on the exact destination, and the run's reach is unchanged. A steered run can ask to send a file, never
send one. The operator reads the destination on the card: a URL or bucket the operator does not recognise is a no. The
agent never sees the operator's Slack, git or AWS sign-in. An S3 destination counts as a cloud write and says so on the
card. No PROD connection is touched. Merge stays the operator's button.

## API

### Common

`SendDestination`, one of:

- `{ "kind": "slack", "channel": "<id or #name>", "text": "<message>" }`
- `{ "kind": "repo", "repo": "<name>", "branch": "<branch>", "path": "<path in the Repo>" }`
- `{ "kind": "s3", "address": "s3://bucket/key" }`
- `{ "kind": "url", "url": "https://..." }`

The tool is `send_file` with `{ "name": "<file in the output folder>", "to": <SendDestination> }`. It is an in-process tool
of the console's MCP server, not an HTTP route. Its Approval is a `command` Approval of the existing list and decision
endpoints, and its summary reads `Send <name> (<size>) to <kind>: <destination>`.

| Error code          | When                                                                    |
| ------------------- | ----------------------------------------------------------------------- |
| `not_found`         | No such file in the output folder, no such Repo or channel              |
| `validation_failed` | Bad address, path outside the Repo, `http://`, the default branch       |
| `not_connected`     | Slack Connector not connected, `aws` missing or not signed in           |
| `upstream_failed`   | The host answered with an error after a yes                             |

## UI

No new screen. The Approval card names the kind and the exact destination. An S3 card carries a cloud-write tag. The
card for a URL shows the whole address, never cut.

## Rejected

- **Let the run reach the destination itself** (widen the Network allowlist, expose `~/.aws` or the Slack token): a run
  steered by log text could send out whatever it reads, which is the case ADR 0006 closes.
- **Skip the Approval when the operator's message names the target**: see Settled.
- **A separate tool per destination**: four tools, four card shapes, and more for a run to misuse.
- **Slack through the Slack MCP server's file tools in the run**: those tools run outside the sandbox and read a path the
  agent names, so they reach any file the daemon can. The daemon reads only the output folder.

## Glossary

- **Send**: copying an Output file to a destination outside this Mac's folders (Slack, a Repo branch, S3, a URL) after the
  operator's Approval. The daemon sends; the agent only asks.

## ADR

- **Operator approves agent never merges** (0002): rewrite in place. The agent sends a file off this Mac only by asking:
  `send_file` raises an Approval in every Access mode that shows the exact destination, and only the operator's yes has
  the daemon send. Considered Options gains "let the run reach the destination" and "skip the Approval for a destination
  the operator named", with why each lost.

## Seams

- **Destination parsing and refusal** (unit): 2, 7, 8, 9, 10, 11.
- **`send_file` tool and Approval** (backend + SQLite): 1, 3, 4, 5, 12, 13, 14, 15.
- **Slack send** (backend with a fake Slack MCP server): 6.
- **Repo send** (backend with a temp git repo): 7.
- **S3 and URL send** (backend with a fake `aws` and a local HTTPS server): 8, 9.
- **Approval card** (browser): 3.

## Out of scope

- Receiving files from a destination, a size limit, other clouds and chat apps. Each is its own spec.
