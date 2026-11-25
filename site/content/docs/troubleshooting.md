# Troubleshooting

Fixes for the failures people hit between install and a first run. Each entry gives the message you see, what causes it and what to do. If yours is not here, the last section says what to send.

## Install

### The installer says the platform is unsupported

`ops-console install: unsupported platform <os> <cpu>; ops-console runs on macOS on Apple silicon or Intel`

Ops Console runs on macOS only. Install it on a Mac.

### The installer says the Mac is too old

`ops-console install: ops-console needs macOS 13.5 or later; this Mac runs <version>`

The bundled Node and its native modules need macOS 13.5 or later. Update macOS, then run the installer again.

### The download fails

`ops-console install: could not download <url>`

`curl` could not fetch the file. Check the network and, if you set `OPS_CONSOLE_VERSION`, that the version exists in the [release notes](/releases/), then run the installer again.

### The checksum does not match

`ops-console install: checksum mismatch for <file>; nothing was installed`

The downloaded file did not match its published checksum. Nothing was installed. Run the installer again.

### `ops-console: command not found`

`<home>/.local/bin is not on your PATH. Add this line to your shell profile:`

The installer links the command into `~/.local/bin`, which your shell does not search. Add this line to `~/.zshrc`, then open a new terminal:

```
export PATH="$HOME/.local/bin:$PATH"
```

### Homebrew says it is the Intel one

`ops-console: this Homebrew is the Intel one; install the native Homebrew in /opt/homebrew and run brew install again`

An Intel Homebrew is running on an Apple silicon Mac. Install the native Homebrew in `/opt/homebrew`, then run `brew install ops-console` again.

## Start and stop

### `ops-console start` does not answer

`The daemon did not answer within 15 seconds. Last lines of <home>/Library/Logs/ops-console/daemon.log:`

The command prints the end of the log under that line, and the daemon is stopped again. Read the last lines for the cause. If the Mac is only slow, raise the wait and start again:

```
OPS_CONSOLE_START_TIMEOUT_MS=60000 ops-console start
```

### The port is in use

`failed to start: port <n> is already in use`

It shows in the log tail that `start` prints. Another program holds the port. Start on a free one:

```
OPS_CONSOLE_PORT=4546 ops-console start
```

### Another daemon is running

`failed to start: another daemon (pid <n>) is already running on <data folder>`

A second console is using the same data folder. Stop that one, then run `ops-console start`.

### launchd refuses to load the job

`launchctl could not load <home>/Library/LaunchAgents/dev.ops-console.plist: ...`

The output often ends in `Bootstrap failed: 5: Input/output error`, which means launchd has not finished unloading the previous run. Run `ops-console stop`, then `ops-console start`.

### An update fails

The console shows the last line the installer printed, or `install.sh exited <code>`. Run `ops-console update` in a terminal to see the whole message, and look it up under [Install](#install).

## Keychain

### A banner says the Keychain is waiting

`Keychain is waiting for the Mac's password prompt`

macOS is asking for your login password and has not been answered for 10 seconds. Answer the prompt on the Mac. The banner clears when the waiting calls end.

### A run or step fails with `keychain_timeout`

`Keychain is waiting for the Mac's password prompt`

The call waited 60 seconds for the Keychain and gave up. An answer that comes late is discarded. Answer the prompt, then retry the run or step. While a wait is showing, new Keychain calls fail at once.

### The same failure during an update

`keychain_timeout`

The call waited 90 seconds for the Keychain handover to move its item. The handover keeps running in the background. Wait for it, then retry.

### The Setup agent page says the handover was refused

`Handover refused: previous app failed its check`

The page gives a reason, such as `it is not an app bundle` or `its bundle fails codesign --verify --strict`. The items stay with the previous version's app, so macOS may ask for the login password once per item. Fix or delete the previous version's folder under `~/.ops-console/versions`, then run `ops-console stop` and `ops-console start`. The check runs again on the start.

## Run sandbox

### The Run sandbox reads unavailable

`Agent runs fail rather than run without the sandbox.`

`/usr/bin/sandbox-exec` failed or took more than 5 seconds, and the Setup agent page gives its last line as the reason. Agent runs fail until it works, and no setting turns the sandbox off. Include the reason in an issue, as described under [When it is not here](#when-it-is-not-here).

## Permissions

### Full Disk Access is off

`The Setup agent cannot start until you turn this on in System Settings.`

On the Setup agent page, choose Open Settings. Drag Ops Console from the Finder window into the Full Disk Access list and switch it on. Then run `ops-console stop` and `ops-console start`.

## When it is not here

Run `ops-console status`, copy the last lines of `~/Library/Logs/ops-console/daemon.log`, and note the version from `ops-console --version`. Open an issue on the [issue tracker](https://github.com/narrowananth/ops-console/issues) with them. The repo is public, so remove secrets, connection strings and customer data from the log first.
