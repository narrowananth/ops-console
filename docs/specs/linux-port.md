# Linux port

**Status:** draft
**Built:** items 3 to 22 and 29 to 33 except what waits on a Linux machine; the Linux Run sandbox rules (23 to 28), ADRs 0004 and 0006, and Linux publishing are not built. See Built notes at the end.
**Design:** none. Permissions: the Full Disk Access row stays macOS-only, and the Keychain, Start at login and Run sandbox rows gain Linux text and fixes.

## Problem

The console installs on macOS 13.5 or later and nowhere else. A developer on Linux, or on a Linux server they reach by SSH or a desktop session, cannot install it, and neither can anyone on Windows through WSL2 ([roadmap](../roadmap.md), steps 1 and 2).

Three parts of the macOS design have no Linux twin by name. Secrets live in the login Keychain ([ADR 0004](../adr/0004-secrets-in-keychain.md)). A run's commands are kept out of that Keychain by Seatbelt ([ADR 0006](../adr/0006-agent-runs-sandboxed-by-the-os.md)). launchd starts the console at login. Each needs a Linux answer that keeps the same promises: no secret on disk, no run command that can read one, and a run that fails when it cannot be kept out.

The Run sandbox is the open part. The Agent SDK sandbox uses bubblewrap on Linux, and its documentation says a command's `localhost` is private to it there, Docker needs a bypass, and blocking Unix sockets takes an optional seccomp filter. Those three differ from what ADR 0006 promises on macOS. A spike on a Linux machine settles them before any ADR text is rewritten.

## Behavior

### Spike gate

1. A written spike runs on Ubuntu LTS, Debian stable and Fedora, on a desktop session and on a headless SSH login, and on WSL2. It records, with the sandbox settings the console uses today:
   - whether a run's command can connect to the Secret Service, by every route: the D-Bus session socket at the path `DBUS_SESSION_BUS_ADDRESS` names (which may not be under `$XDG_RUNTIME_DIR/bus`), gnome-keyring's own socket under `$XDG_RUNTIME_DIR/keyring`, and an abstract socket, which has no path to deny. Whether a deny on each path, an environment without `DBUS_SESSION_BUS_ADDRESS`, or the sandbox's per-command network namespace stops each route;
   - whether a run's command can bind a port and reach it from a second command, reach a port a tunnel opened on the host, and reach a database on `localhost`;
   - whether a Testcontainers suite and `docker` run in the sandbox, and what bypass they need;
   - whether the empty placeholder files the sandbox makes for git control files that do not exist break `git`, a worktree add or a commit in a plain checkout and in a Session worktree;
   - whether a Go CLI such as `gh` checks certificates and signs in through `GH_TOKEN`;
   - where Claude Code keeps its stored MCP sign-in on Linux;
   - whether `@napi-rs/keyring` loads and reads and writes an item on each platform above;
   - whether `node-pty` has a Linux prebuild or compiles at install time, and that the compiled module the release carries loads on each platform above with no compiler on the machine.
2. No ADR 0004 or 0006 text changes, and no Linux code ships, until the spike's results are in this spec's Settled section and the operator approves them.

### Install and start

3. `install.sh` installs on Linux x64 and arm64 on a glibc distribution of version 2.35 or later (Ubuntu 22.04, Debian 12, Fedora 36). It refuses other systems and older distributions with the reason, as it refuses an old macOS. A musl distribution such as Alpine is refused.
4. A release carries `ops-console-linux-x64` and `ops-console-linux-arm64` tarballs next to the two macOS ones, with their sha256 in `checksums.txt`. The installer checks the sum before it installs anything. Each tarball is built on a Linux runner of its own architecture, where the native modules, `node-pty` included, are compiled and bundled, so the operator's machine needs no compiler, Python or sudo.
5. The install needs no sudo and writes only under the operator's home, as on macOS. The console never installs a system package; it names what is missing.
6. `ops-console start`, `stop`, `status`, `open`, `logs`, `update` and `uninstall` work as on macOS. `start` enables and starts a systemd user service that restarts the daemon if it stops (`systemctl --user enable --now`), and `stop` disables and stops it (`disable --now`), so it stays stopped across logins until the next `start`, as `launchctl disable` does on macOS.
7. On a system with no systemd user manager, `start` says so and exits non-zero, and runs no daemon.
8. `ops-console open` opens the UI in the default browser through `xdg-open`. With no desktop it prints the address.
9. A release is smoke-tested on a Linux runner of each architecture the tarball was built on: install from the built tarball, `start`, `status`, `open`, `stop`, and load the compiled `node-pty` module, as the macOS job runs its own start and stop.

### Start at login

10. Permissions shows Start at login on Linux: on when the service is enabled and not stopped, off otherwise, and for a dev build "dev build".
11. When the operator's account has no lingering, the service stops at logout. Permissions says so and shows the one command that turns lingering on. The console never runs it.
12. The Full Disk Access row and the Open Settings buttons for it and for Login Items do not appear on Linux.

### Secrets

13. On Linux, a Connection's secret, an MCP Server's env vars, a Connector's tokens and the CLIProxy key are kept in the desktop's Secret Service under the same service names and keys as the macOS Keychain. Nothing reaches `state.db`, a log, a WebSocket payload or the browser.
14. A read of a secret already read stays in memory, so a second read makes no call.
15. The Keychain timeouts apply: a call fails at 60 seconds with `keychain_timeout`, a call pending past 10 seconds shows as the Keychain wait, and a call made while that wait shows fails at once. On Linux the wait is usually an unlock prompt for the keyring.
16. With no Secret Service reachable (a headless login with no D-Bus session, no keyring daemon), the console stores no secret. Saving a Connection or MCP Server that needs one fails with the reason and what would provide a Secret Service. A Connection that needs no secret still works: with no Secret Service a read finds nothing and a delete has nothing to remove. A Secret Service that is there but refuses or fails, as when its unlock prompt is dismissed, fails the call with its own error and is never read as "nothing stored", so a delete never drops a Connection while its secret stays in the keyring. Permissions shows the Keychain row as unavailable with the same reason.
17. The console writes no secret to a file, encrypted or not, and to no kernel keyring. Reading a secret another program keeps in its own file, as in item 20, is not a write.
18. Updating the console on Linux has no Keychain handover and no Handover refusal, and no start waits for one. A secret saved by one version is read by the next.
19. The Setup agent's local Keychain reads stay macOS-only. On Linux the console reads no item it did not write, apart from the stored MCP sign-in in item 20.
20. The New Relic read of Claude Code's stored MCP sign-in works on Linux from where Claude Code keeps it there, which the spike confirms (item 1); until then this item is unverified. The daemon holds the token in memory for the call, never writes or refreshes it, and a missing or unreadable sign-in reads as needs auth.

### Run sandbox

21. Every agent run's commands run in the Run sandbox on Linux and WSL2, in every Access mode, as on macOS. A run fails before its first command, and its Session shows why, when the sandbox is unavailable. The console never runs a command outside it, and no Setting turns it off.
22. Permissions' Run sandbox row says whether bubblewrap and its network relay are installed, whether unprivileged user namespaces work, and names every missing piece with its install command for Debian or Ubuntu, Fedora and Arch. On a WSL1 distribution it says WSL2 is required. A check runs a trivial command in the sandbox each time the row is read.
23. A run's commands cannot reach the secret store by any route the spike found: the keyring's data folder, the D-Bus session socket at the path `DBUS_SESSION_BUS_ADDRESS` names, gnome-keyring's own socket, and abstract sockets. The deny paths come from the environment, not from a fixed path, and the run's environment carries no `DBUS_SESSION_BUS_ADDRESS`. If a route stays open, the run fails closed (item 24).
24. When the spike finds no way to keep a run's commands from the Secret Service, Settled records the design that replaces it, and until then Linux is not released.
25. A run's commands cannot read the installed app folder, and cannot write the git control files the daemon's `git` reads outside the sandbox. The placeholder files the sandbox makes for control files that do not exist leave `git`, worktrees and commits working.
26. A read-only run cannot change its working folder, as on macOS.
27. The agent's file tools are held to the same closed paths on Linux. The folders a `save_file` never writes in gain the keyrings, the user's systemd units and the autostart entries on Linux; macOS keeps its own list.
28. What a run's commands can do on `localhost`, with Docker and with Unix sockets follows Settled once the spike decides it. The SDK documents `allowLocalBinding` as having no effect on Linux and gives each command a private `localhost`; if the spike confirms that, ADR 0006's promise of open `localhost`, servers and Docker does not hold there and its rewrite says so. The Run sandbox row, the Glossary and ADR 0006 state exactly what holds on Linux and where it differs from macOS.

### Other platform code

29. Choosing a folder to import a Repo or a Log folder opens a native dialog through `zenity` or `kdialog` when one is installed, and otherwise shows a path field in place of the Choose button on the Repos tab and the Log folder step. A cancelled dialog returns no folder; a dialog that cannot open a display is an error, not a cancel.
30. Opening a Session's worktree in an editor or the file manager keeps working on Linux.
31. Local servers the Terminals dock lists come from the system's socket and process tools. When `lsof` is missing the list is empty and says why; a missing `ps` or any other program leaves the list as it was, and nothing else breaks.
32. The terminals open on Linux with the `node-pty` build compiled for that tarball (item 4).
33. The Connectors' "install a missing CLI" prints the install command for each package manager that carries the command (apt, dnf, pacman), Homebrew's when it is installed, and where to download it when no distro packages it, and runs none itself.

### What must not regress

34. macOS behavior is unchanged: Keychain and its handover, Seatbelt, launchd, Full Disk Access, the folder dialog and the two darwin releases.
35. The Homebrew tap and the Brew entry command stay macOS-only.
36. Merge denials, the PROD write rule, `run_integration`'s list and Approvals, and the console's own pushing do not change.

### Browser and Setup agent

37. The Session browser finds Chrome on Linux: `OPS_CONSOLE_CHROME_PATH` first, then `google-chrome`, `google-chrome-stable`, `chromium` and `chromium-browser` on the `PATH`. With none, the browser panel says Chrome is missing, as it does on macOS.
38. The Setup agent's instructions name the config locations of the machine it runs on: on Linux the XDG folders and each app's Linux path, not `~/Library`.

## Settled

- **Keychain**: the Glossary term stays for the operator's secret store on both systems; on Linux it is the Secret Service. The Permissions row keeps its name and its text names the system.
- **Headless secrets**: no Secret Service, no stored secrets. Refused with a reason; no file and no kernel keyring.
- **Library**: `@napi-rs/keyring`, as on macOS, behind the existing `Keychain` interface, with the Linux store pinned to the Secret Service. Left alone, the library falls back to the kernel keyutils keyring when no Secret Service runs, which would store secrets in kernel memory. A pinned store makes opening an item throw when none runs, and the console reads that as "no Secret Service". The spike confirms the library loads and works on the supported systems.
- **Availability probe**: one at a time. The probe holds a native slot until the keyring answers, so a call made while one waits on a locked keyring reuses it, and nothing is kept once it settles. Two visits to Permissions never hold every slot a real secret call needs.
- **Handover**: none on Linux. The Secret Service has no per-app access list, so the check, owner file and Handover refusal do not run.
- **Service manager**: systemd user service. No system service, no root.
- **Lingering**: the console never enables it; it shows the command.
- **Packages**: the console never installs a system package. It names bubblewrap, socat, a dialog tool and the lingering command.
- **Libc**: glibc 2.35 or later. The release builds on the oldest glibc the installer accepts, so what loads there loads everywhere it admits. A system with an older glibc, such as RHEL 9 (2.34), is refused until a build container with an older glibc is added.
- **Linux locations**: data `${XDG_DATA_HOME:-~/.local/share}/ops-console`, log `${XDG_STATE_HOME:-~/.local/state}/ops-console/daemon.log`, unit `${XDG_CONFIG_HOME:-~/.config}/systemd/user/ops-console.service`. An XDG variable counts only when it is an absolute path, for the daemon and the CLI alike. `OPS_CONSOLE_DATA_DIR` overrides the data folder.
- **WSL2**: the Linux build, tested in the spike. WSL1 is refused. No native Windows build.
- **Sandbox failure**: the run fails when the sandbox cannot start. The SDK's `failIfUnavailable` stays on.
- **Release order**: macOS keeps shipping. Linux ships once the spike's results are in this section and ADRs 0004 and 0006 are rewritten.

## Not required

- **Secrets across reboot without a keyring**: a headless machine with no Secret Service keeps no secrets. The operator installs one or uses a desktop session.
- **Identical Run sandbox reach**: a run on Linux may reach less than on macOS, as the spike decides. The Run sandbox row says what.
- **Package managers**: no `.deb`, AUR, npm or npx package in this change. They follow the port.

## Safety

The agent's reach on macOS is unchanged. On Linux it gets the same limits where the platform allows them: no read of the secret store or the installed app, no write of the git control files, no way out of the sandbox, and the same Approvals. Where Linux cannot keep a limit, the run fails closed or the Run sandbox row says so (items 24 and 28). The agent never installs a package, enables lingering or edits a system file.

## API

### `GET /terminals/disk-access`

Returns `granted: null` and `app_path: null` on Linux, as it does off macOS today.

### `GET /terminals/start-at-login`

Reports `on` from the systemd user service on Linux. Adds `manager` (`launchd`, `systemd`, or `null` where there is none) and `lingering` (`true`, `false`, or `null` where it does not apply) to the response so Permissions can word the row and show item 11. The shared `StartAtLogin` type gains the field, and the schema and its consumers change with it.

### `POST /terminals/start-at-login/settings`

Does nothing on Linux; Permissions shows the lingering command instead of a button.

### `GET /terminals/run-sandbox`

Same body, `status` and `reason`. On Linux `reason` names the missing piece from item 22.

### `GET /repos/folder-dialog`

Whether a folder dialog can open on this machine, so the UI shows a path field when it cannot.

```json
{ "data": { "available": false } }
```

### `GET /sessions/:id/local-servers`

Gains `notice`: a string saying why the list may be empty when `lsof` is missing, `null` otherwise.

### `GET /terminals/keychain-wait`

Same body.

### `GET /terminals/keychain`

New. Whether this machine can store secrets.

```json
{ "data": { "available": false, "reason": "no Secret Service answered: no D-Bus session", "store": "secret_service" } }
```

- `available`: false when no Secret Service is reachable (item 16). Always true on macOS.
- `reason`: null when available.
- `store`: `keychain` or `secret_service`, so Permissions words the row for the system.

### Errors

| Status | Error code | When |
| ------ | ---------- | ---- |
| 503 | `keychain_timeout` | A call passes 60 seconds, or a Keychain wait is showing (item 15). |
| 409 | `invalid_state` | A secret save with no Secret Service (item 16), or a folder dialog with no dialog tool (item 29). |

## UI

- **Permissions, Keychain row**: macOS text unchanged. Linux text says the Secret Service holds the secrets and the wait is an unlock prompt. With none reachable, the row is red with the reason and what provides one.
- **Permissions, Start at login row**: on, off or dev build, plus the lingering line from item 11 when it applies.
- **Permissions, Run sandbox row**: on or unavailable with the missing piece and its fix. Text on what a run can reach is the platform's.
- **Permissions, Full Disk Access row**: absent on Linux.
- **Folder choosers**: with no dialog tool the Choose button is hidden and the path field stays.

No design screen changes layout. The rows keep their position and shape.

## Rejected

- **keyutils kernel keyring as the headless fallback**: no file holds a secret, but they vanish at reboot, and the operator re-enters every secret.
- **An encrypted file under the data folder**: survives reboots, but reverses an option ADR 0004 rejected and adds a passphrase flow and key handling.
- **A Docker or micro-VM sandbox**: ADR 0006 already rejected it for the `curl | sh` install and the host's CLIs.
- **Native Windows now**: no sandbox and no secret store with a Linux-shaped design. WSL2 reuses this build.
- **A system service or `.deb` first**: needs root, which the console never asks for.

## Glossary

- **Keychain**: the operator's secret store: the login Keychain on macOS, the Secret Service on Linux.
- **Run sandbox**: gains the Linux mechanism and a note that what a run can reach differs from macOS where the spike says so.
- **Start at login**: a service manager starting the installed console at login: launchd on macOS, a systemd user service on Linux.
- **Keychain wait**: the pending call is a login password on macOS and an unlock prompt on Linux.

## ADR

- **0004, Secrets in the Keychain**: on Linux the Secret Service holds the same keys; no handover; no secret without it. Rewritten in place after the spike, with the macOS-only design as the first design in Considered Options.
- **0006, Agent runs are sandboxed by the OS**: bubblewrap on Linux and what the spike finds on `localhost`, Docker, sockets and placeholders. Rewritten in place after the spike and the operator's approval.

## Seams

- **Spike checklist** (manual, Linux and WSL2): 1.
- **Keychain unit, with a fake entry** (unit): 13 to 15, 17 and 18, and 16's refusal.
- **Keychain availability and Permissions routes** (backend + SQLite): 10, 11, 16, 22, and the API above.
- **Run sandbox settings** (unit): 21, 23 and 25 to 27, as built from the spike's results.
- **Run sandbox on a Linux runner** (browser or CI): 21 and 22 with a real bubblewrap.
- **Chrome path and Setup agent instructions** (unit): 37 and 38.
- **Folder dialog, local servers and package-manager hint** (unit with a fake process runner): 29, 31 and 33.
- **Installer, CLI and terminals** (CI smoke test on a Linux runner per architecture): 3 to 9 and 32.
- **Permissions page** (frontend component): 10 to 12 and the UI states.

Items 19, 20, 30, 32 and 34 to 36 are pinned by the existing tests for those areas run on a Linux runner. Item 2 is process, not code.

## Out of scope

- `.deb`, AUR, npm and npx packages: the roadmap, after this port.
- A native Windows build: roadmap step 2.
- Alpine and other musl systems.
- Localization.

## Built notes

Built on branch `linux-port`, the spike-independent parts only. Each item was checked on this Mac with fakes; nothing ran on Linux.

- Built: the install, CLI and systemd side (3 to 9), start at login (10 to 12), the Secret Service backend, refusal and availability route (13 to 19), the Run sandbox gate and its fail-closed rule (21, 22), the folder dialog and its typed-path fallback (29), the empty server list with its `lsof` notice (31), the missing-CLI message (33), the Linux data folder, and the release build job. `release.yml` can be run by hand on a branch (`workflow_dispatch`): it builds and smoke-tests the Linux tarballs and publishes nothing.
- Held: no agent run starts on Linux while the Run sandbox is unverified there (`LINUX_RUN_SANDBOX_VERIFIED` is false), and the Run sandbox row says so. Items 23 to 28 wait on the spike, except the `save_file` folders in item 27.
- Not built: the ADR 0004 and 0006 rewrites, and publishing the Linux tarballs (the release's `checksums.txt` stays macOS-only).
- Unverified: item 20 (where Claude Code keeps its sign-in on Linux); the native error wording that tells "no Secret Service" from "refused" (item 16), what the pinned store throws at open on each system, the package names in item 33 on each distro, the namespace flags in item 22 against the SDK's own, and every Linux behavior on a real machine. No test pins item 18 (the handover skip) or the Session's "why" when a run fails closed (item 21).
- Follow-ups: the spike script and its results template are in `docs/linux-spike.md` and `scripts/linux-spike/spike.sh`, written but never run. Items 37 and 38 cover the two Linux gaps found while building (the Session browser's Chrome path, the Setup agent's macOS paths); they are not built, and they matter once runs start on Linux.
