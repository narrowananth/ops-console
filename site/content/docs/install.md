# Install and update

Ops Console runs on macOS 13.5 or later, on Apple silicon or Intel. The install needs no sudo.

## Install

```
curl -fsSL https://raw.githubusercontent.com/narrowananth/ops-console/main/install.sh | sh
ops-console start
ops-console open
```

The installer puts a release in `~/.ops-console/versions/<version>`, points `~/.ops-console/current` at it and links `~/.local/bin/ops-console`. The release carries its own Node, so nothing else needs installing. To install a given version instead of the latest, set `OPS_CONSOLE_VERSION`:

```
curl -fsSL https://raw.githubusercontent.com/narrowananth/ops-console/main/install.sh | OPS_CONSOLE_VERSION=0.1.60 sh
```

A shell running under Rosetta on an Apple silicon Mac installs the Apple silicon build.

## Start at login

`ops-console start` registers a launchd job that starts the console at login and again if it stops. macOS lists it as Ops Console under System Settings › General › Login Items & Extensions › App Background Activity. Keep it switched on there, or it won't start at login.

The console listens on `127.0.0.1:4545`. Set `OPS_CONSOLE_PORT` when you run `start` to use another port. Several browsers can use the console at once, and `ops-console open "Google Chrome"` signs in a browser other than the default.

## Commands

| Command | What it does |
| ------- | ------------ |
| `ops-console start` | Start the daemon under launchd and keep it running |
| `ops-console stop` | Stop it until the next `start` |
| `ops-console status` | Running or stopped, with pid, version, port and health |
| `ops-console open [app]` | Open the console signed in, in the default browser or the browser app named |
| `ops-console logs` | Follow the daemon log |
| `ops-console update` | Install the latest release and restart a running daemon |
| `ops-console uninstall` | Remove the install. Data and logs stay |
| `ops-console --version` | Print the installed version |

## Update

Run `ops-console update`. It installs the latest release and restarts a running daemon. It keeps the new version and the previous one. What changed in each version is in the [release notes](/releases/).

## Where things live

| What | Where |
| ---- | ----- |
| Data: database, attachments, scratch copies, Claude account folders | `~/Library/Application Support/ops-console` |
| Daemon log | `~/Library/Logs/ops-console/daemon.log` |
| Secrets | The macOS Keychain, under the service `ops-console` |
| The install | `~/.ops-console` |

## Uninstall

`ops-console uninstall` removes the install and leaves your data and logs. To remove everything, delete the data folder and the log folder yourself, and the Keychain items named `ops-console` in Keychain Access. Disconnect your Connectors first, so each one revokes its access at the service.
