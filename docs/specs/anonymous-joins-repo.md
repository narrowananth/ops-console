# Anonymous Session joins a Repo

**Status:** shipped
**Design:** none, no screen changes. The approval shows in the Session's existing Approval panel.

## Problem

An Anonymous Session works in an empty folder of its own. When the operator names a Repo in it and describes an issue,
the agent cannot work on that Repo: the Run sandbox lets a run write only in its working folder, and the pull request
tool exists only inside an imported Repo. The agent could only clone a copy that never reached the checkout.

## Behavior

1. An Anonymous Session's agent is told it has no Repo and to call `join_repo` first when the operator names a
   repository, a service or a folder, or describes an issue in one.
2. `join_repo` takes the Repo's name, its path or its Git URL (`https://`, `git@host:` or `owner/name`). A path, or a
   folder inside it, beats a Git URL, and a Git URL beats a name. A name that two imported Repos share is refused,
   naming both, and the agent asks which one.
3. A call that matches no imported Repo is refused before it asks. The agent is told to clone the repository into its
   folder when it is on a Git host, and to tell the operator to import the Repo for branches and pull requests.
4. A match asks the operator in every Access mode, `full` included: "Move this Session into the Repo <name> (<path>)".
   A no leaves the Session anonymous and the agent is told not to ask again.
5. A yes turns the Session into a `repo` Session on that Repo, on the branch checked out in the Repo's folder. The run
   in progress ends with the agent's one line, and the console starts the next turn at once in the Repo's folder, with
   the conversation so far. That turn tells the agent to work on a new branch (`git switch -c`), commit (the repo's hooks
   run and must pass) and call `open_pull_request` when done; the operator approves, and the console pushes the branch and
   opens the pull request (`console-opens-pull-request` Behavior 12). A Repo with no Git host the console can open on has
   no such tool; the agent says so and leaves the commit on its branch. From then on the Session has a branch, the Changes panel, commit hooks and the pull request
   button like any `repo` Session, and it moves from "No Repo" to its Repo's group in Workspace.
6. The tool is offered only in a run the operator started, in an Anonymous Session no Alert made. A Playbook step, a
   Verification and a Fix keep working in their own clone.
7. A Session that already has a Repo cannot call it again.

## Not required

- **Choosing the branch when joining**: the Session takes the branch checked out. The agent switches or makes a branch
  in the Repo like any `repo` Session.
- **Importing a Repo from a Git URL**: the operator imports it on Repos; until then the agent works in a clone.
- **Moving a Session back to anonymous.**

## Safety

The Run sandbox is unchanged (ADR 0006): a run still writes only in its working folder. Joining changes which folder
that is, and only after the operator approves, so the Session's later work is the same as a `repo` Session's, under its
Access mode, Approvals and the Network allowlist. Joining writes no file and runs no command.

## Seams

- **Daemon** (`backend/test/anonymous-joins-repo.test.ts`): 1 to 7.
