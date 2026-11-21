# Sessions and Access modes

A Session is one conversation between you and the agent. It is named for its first task and runs in one Repo on one branch.

## Where a Session runs

Each Session works in its own git worktree under the data folder, so Sessions on different branches never share a checkout, and your own folder is never switched. Two kinds of Session have no Repo: a Dev tools Session and an Anonymous Session.

A pull request has a Session of its own for the agent's replies, and an Alert has one for its Verification and Fix. The agent may start Spawned Sessions from a Session, and the Running tray shows what is running.

## Access modes

The Access mode is what the agent may do in a Session without asking. There are four, and each maps to a Claude Code permission mode.

| Mode | Claude Code mode | What it means |
| ---- | ---------------- | ------------- |
| Supervised | default | The agent asks before the edits and commands that need a yes |
| Accept edits | acceptEdits | File edits go through without asking |
| Auto | auto | Claude Code decides what needs a yes |
| Full | bypassPermissions | The agent asks about nothing but a PROD write |

A write to a PROD Connection asks in every mode. When the agent asks, you get an Approval to accept or refuse. Choose the mode to suit the data the Session can reach. In full, the console's own tools (integration writes, `join_repo`, `save_file`, `spawn_sessions`, `start_process` and `browser_evaluate`) run at once, and the agent can edit the Google Docs and Sheets you connected without asking. The rules that hold in every mode are on the [Safety](/docs/safety/) page.

## What a Session can use

- **The Browser panel** shows pages from the Session's Chrome beside the conversation, one tab each. You and the agent drive the same tabs, and the panel lists the outside hosts a page called. Inspect shows Chrome's own DevTools for the tab under the page, or beside it or in a window of their own: Elements, Console, Sources, Network, Application and Memory. Device emulation, Performance recording and Lighthouse do not work there.
- **The Terminals dock** runs shells and Session processes. A server a process starts opens its page in the Browser panel.
- **Output files** are files the agent writes for you, kept in a folder per Session. To put a file in another folder, such as Downloads, the agent calls `save_file`, and you approve the destination.
- **Pull requests** open through the console, never through the agent. You press the button, or the agent asks the console to open one, and the console pushes the branch with your git access and never forces it.
- **Repos** you open from the composer's Repos chip become part of the Session. The agent writes in them as it does in its own folder, and still never pushes.

## Pull request review

On any open pull request, yours or a teammate's, you can start an Agent Review. The agent reads it and compares it with the target branch, and may run the tests in a scratch copy. The console posts the findings and one summary comment, and the agent never posts.

Address comments starts a Comment pass: the agent changes code in a scratch copy for the review comments you ticked, and the console commits and pushes that one branch, never with force. The pull request page lists the Merge checks. Merge stays off until a reviewer approved and while the branch conflicts with its base. Merging is always your button.
