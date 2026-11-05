# Verify Keychain Handover Source

**Status:** shipped
**Design:** none. Permissions page: the Keychain row gains a Handover refusal state. Follows no design screen.

## Problem

On the first start of a new version, the console runs the previous version's app to take its Keychain items, then writes
them back under the new app. It runs whatever executable `keychain-owner.json` names, or the newest other folder under
`~/.ops-console/versions/`, without checking it. A planted or half-written bundle there would run as the operator and
could hand the new app items of its own choosing, which the console would store as the operator's secrets. The operator
has no way to tell this happened.

The old app never receives a secret in this flow. The new app only reads its output. So this is a guard against
poisoned items and a stray executable, not a defence against secret theft. Anyone who can write to `versions/` can
already replace the installed app that launchd runs at login, so the guard adds no new boundary.

## Behavior

1. A previous app that passes the check hands its items over as today, and the operator sees nothing new.
2. The check has three parts. The executable's real path sits inside another version folder under
   `~/.ops-console/versions/`. `codesign --verify --strict` passes on its app bundle. Its bundle identifier equals this
   app's. The check runs before anything is taken.
3. A failed check refuses the handover. The console does not run `take`, writes nothing to the Keychain and leaves
   `keychain-owner.json` as it was. It writes one `WARN` line to the log. Keychain reads that follow use the items where
   they are, so macOS may ask for the login password once per item, as it does after any failed handover.
4. `codesign` missing, exiting with an error, or running past 10 seconds counts as a failed check. The reason names the
   tool failure.
5. A recorded owner in `keychain-owner.json` goes through the same check. When it fails, the console does not fall back
   to searching `versions/`.
6. A recorded owner whose executable is gone is not a refusal. This app is recorded as the owner and no items move.
7. With no recorded owner, the console searches `versions/` as today and checks only the newest candidate. When it
   fails, the handover is refused and older candidates are not tried.
8. A refusal is kept in the daemon's memory. A restart clears it and runs the check again. A fixed bundle, or a deleted
   bad folder, passes on the next start with no step from the operator.
9. `GET /terminals/keychain-handover` says whether the handover was refused and why. `keychain.handover_refused` is
   sent once when the refusal is set.
10. The Permissions Keychain row shows "Handover refused: previous app failed its check" and the reason,
    with no control. A reload mid-refusal shows it again, and every open browser shows it. The row shows it beside the
    Keychain wait when both hold.
11. Nothing else changes: the wait banner, the 60-second and 90-second limits, the rollback `put` after a failed write,
    and `pnpm dev`'s own handover. No secret reaches the log line, the endpoint or the event.

## Settled

- **Guard, not defence**: the check guards against a planted or damaged bundle poisoning the items. It does not claim to
  stop a local attacker who can already replace the installed app. ADR 0004 gains one line saying so.
- **Valid previous app**: a real path inside another version folder, a bundle that passes `codesign --verify --strict`,
  and the same bundle identifier as this app. The identifier is the bundle's `CFBundleIdentifier`.
- **No `cdhash` pin**: an ad hoc signature carries no signing authority, and a new Node makes a new app with a new
  `cdhash`. An exact match would refuse the handover on every Node bump.
- **Fail closed**: a tool failure refuses. The check runs `codesign` with an argument list and no shell, bounded at
  10 seconds.
- **One check for every route to the executable**: the recorded owner and the `versions/` search share it.
- **A refusal does not retry**: it ends the handover for this start. The next start checks again.
- **Item 16 of the earlier spec**: [agent-sandbox-and-keychain-timeout](agent-sandbox-and-keychain-timeout.md) said the
  handover stays as it is. This spec adds the check in front of it and changes nothing after it.
- **Refusal state**: in daemon memory, never in `state.db` or `keychain-owner.json`.
- **Endpoint**: a sibling of `GET /terminals/keychain-wait`. The wait banner keeps its own answer.

## Not required

- **A swap between the check and the run**: the executable can change after it passes. The attacker would be the
  operator's own user, who already owns the boundary.
- **Changes to `pnpm dev`'s handover**: it keeps its current behavior.
- **A signing authority or a pinned `cdhash`**: the bundle is signed ad hoc.
- **A retry or override control**: the operator fixes the folder and restarts.

## Safety

No change. The agent's reach is the same as before. The check runs in the daemon, outside any agent run, and reads no
secret.

## API

### `GET /terminals/keychain-handover`

Next to `keychain-wait`. Answers from daemon memory:

```json
{
  "refused": false,
  "reason": null
}
```

- `refused`: true once a handover was refused in this daemon's life.
- `reason`: why, in words the Permissions row shows, such as the signature check failing or `codesign` timing out;
  null when not refused.

### WebSocket `keychain.handover_refused`

Server to client. Fires once, when the refusal is set.

```json
{ "refused": true, "reason": "string" }
```

## UI

- **Permissions, Keychain row**: states are idle, waiting with the time since (as today), and Handover refused with
  the reason. A failed read of the endpoint shows the row's usual error state. No control on any state. In a dev build
  the row reads the dev daemon's state, which never refuses, since `pnpm dev` hands over on its own.

## Rejected

- **Pin the previous app's `cdhash`**: breaks the handover on every Node bump.
- **Fall back to the next candidate after a failed check**: hides a swapped file instead of showing it.
- **Store the refusal**: the next start checks again anyway, so a stored flag could only go stale.
- **A Permissions override to hand over anyway**: it would turn the guard into a prompt the operator clicks through.
- **Add the field to `keychain-wait`**: the wait banner polls that answer, and a refusal is a separate fact.

## Glossary

- **Keychain handover**: the first start of a new version taking the Keychain items from the previous version's app,
  so macOS does not ask for the login password once per item.
- **Handover refusal**: the console declining a Keychain handover because the previous app failed its check. It shows
  on the Permissions page until the next start.

## Seams

- **`adoptKeychainItems` with a fake `codesign` and a fake `run` (unit, `keychain-handover.test.ts`)**: 1 to 8 and 11.
  The fake `codesign` returns a pass, a failure, an error and a hang.
- **`GET /terminals/keychain-handover` and `keychain.handover_refused` (backend)**: 9, and the restart reset in 8.
- **Permissions Keychain row (frontend component)**: 10.

## Out of scope

- **A real signing identity**: with one, the check could name a signing authority. It goes in its own spec if releases
  are ever signed that way.
