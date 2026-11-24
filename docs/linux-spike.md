# Linux spike

The check that [linux-port](specs/linux-port.md) item 1 asks for. Its results settle ADRs 0004 and 0006 for Linux. Until they are in the spec's Settled section and approved, no Linux run starts (`LINUX_RUN_SANDBOX_VERIFIED` stays false) and no Linux tarball is published.

## Run it

On each of Ubuntu LTS, Debian stable, Fedora and WSL2, in a desktop session and again over a headless SSH login:

```
sudo apt install bubblewrap socat libsecret-tools    # or dnf, pacman
bash scripts/linux-spike/spike.sh
```

Install the console first (`ops-console start`) so the keyring and `node-pty` rows can run. The script writes `spike-results-<host>-<date>.md` and prints no secret. It drives `bwrap` directly, which approximates the Agent SDK's sandbox. Stage 2 below checks the SDK's own profile.

To get a Linux build before the spike, run the Release workflow by hand on `linux-port` (Actions, Release, Run workflow). It builds and smoke-tests the Linux tarballs and publishes nothing.

## Stage 2: the SDK's own sandbox

Set `LINUX_RUN_SANDBOX_VERIFIED` to true in a dev build only, never committed. Start a Session and ask the agent to run, each as one command, and record what each prints:

- a connection to the session bus socket (`python3 -c "import socket; ..."`, as in the script's `probe_py`) and `secret-tool lookup ops-console-spike none`;
- `curl http://127.0.0.1:<port>` against a server the operator started, and a command that starts its own server and then calls it;
- `docker info` and a Testcontainers test;
- `git status`, `git commit` and `git worktree add` in a Session worktree;
- `gh api rate_limit` with `GH_TOKEN` set.

## What each result decides

| Result | Decides |
| --- | --- |
| A deny on the bus socket path, an unset `DBUS_SESSION_BUS_ADDRESS` or a tmpfs over `XDG_RUNTIME_DIR` stops the probe (V3 to V6) | The deny paths for items 23 and 25, built from the environment. If only `--unshare-net` stops it, abstract sockets are the route and the network namespace carries the guard. If nothing stops it, the run fails closed (item 24) and ADR 0006 needs a different design. |
| A server on the host is unreachable under `--unshare-net` | ADR 0006's "reach `localhost`, servers and database tunnels" does not hold on Linux, and the ADR and the Run sandbox row say so (item 28). |
| `docker info` fails in the sandbox | Docker needs an exclusion on Linux, or ADR 0006 drops Testcontainers there. |
| `git` fails with the placeholder files | `gitControl()` denies only the control files that exist on Linux. |
| `gh` fails the certificate check | The Linux sandbox gets the equivalent of `enableWeakerNetworkIsolation`, or `gh` runs through `run_integration`. |
| A Claude Code credentials file or Secret Service item exists | Item 20's source on Linux. |
| `node-pty` has a Linux prebuild or compiles at install, and loads | Item 4's build note, and whether the release carries `build/Release`. |
| The three keyring error strings (no service, locked and dismissed, denied) | The `REFUSED` and `NO_SERVICE` patterns in `backend/src/keychain/keychain.ts`. |
| Every row on the headless login | The refuse-and-say-why path for secrets (item 16) and the folder dialog fallback (item 29). |

## Results

Paste each system's file below, headed by its name. None are recorded yet.
