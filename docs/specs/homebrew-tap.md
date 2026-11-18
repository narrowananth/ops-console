# Homebrew tap

**Status:** shipped
**Design:** none. No screen changes. Follows no design screen.

## Problem

The only way to install the console is `curl | sh`. Developers who keep their tools in Homebrew cannot list, upgrade or
remove it with the rest, and many will not pipe a script into a shell. The app installs into the operator's home, with
launchd pointing at it and its own update path through the install script, so a normal formula that puts the app in the
Cellar would break that layout.

## Behavior

1. `brew install narrowananth/ops-console/ops-console` installs one command, `ops-console`, into Homebrew's `bin`, and
   prints that the operator runs `ops-console start`. This is the Brew entry command. The formula's install step
   installs no app and writes nothing under the home folder.
2. The Brew entry command with no installed app installs the formula's version from the tarball Homebrew already
   downloaded and checked. The Brew entry command's own messages go to stderr, and the install script's output passes through unchanged.
   It then runs the command the operator typed.
3. The Brew entry command runs the installed command with the same arguments and stdin, and exits with its exit code.
4. After `brew upgrade` brings a newer formula, the next `ops-console` command installs that version when the installed
   one is older. A daemon that was running is stopped and started again on the new version. Then the command runs.
5. When the installed version equals or exceeds the formula's, the command runs with no install and no downgrade. This
   covers an app that updated itself past the formula.
6. `ops-console update` and `ops-console uninstall` skip the version check when an app is installed. With no app,
   `uninstall` says nothing is installed and exits 0, and `update` does the first install, then updates to the newest
   release.
7. `ops-console update` and the app's own update install the newest GitHub release. The formula's version is untouched.
   `brew outdated` compares the formula with the tap and never sees the app's version.
8. Homebrew checks the tarball's sha256 on download, and the install script checks it again before it installs
   anything. A mismatch installs nothing, and the command does not run.
9. An install that fails for any reason prints the install script's message, runs no command, leaves the installed
   version as it was, and exits non-zero.
10. On an Apple silicon Mac with a Rosetta Homebrew, an install the Brew entry command would make is refused: it prints
    that the native Homebrew is needed and exits non-zero without installing. It detects this by an x64 formula
    tarball on a Mac whose hardware reports Apple silicon. Commands that need no install run as usual.
11. An install made by the Brew entry command, `ops-console update` run through it included, makes no `~/.local/bin`
    link and prints no PATH hint. A link made earlier, or by the app's own update, still works. A shell that finds that link first skips the version check, so `brew upgrade`
    reaches the app only when the Brew entry command runs first.
12. `brew uninstall` removes only the command. The app, the data folder and the logs stay. The README and the formula's
    notes say to run `ops-console uninstall` first to remove the app.
13. A tagged release updates the tap in the same workflow run, after the release is published. The job renders the
    formula with the new version and both tarballs' sha256, installs it from a local tap on a macOS runner, runs
    `brew audit --strict`, `brew style` and the formula's own test (`ops-console --version` prints the new version),
    and only then pushes to the tap.
14. A failed tap update fails that job and leaves the release published. The owner reruns the job.
15. The tap holds only generated files: the formula and a README. The token for the tap exists only in the release
    job's secrets.
16. Without the Brew entry command's variable set, the install script, the tarball and the checksums work as before.
17. The README and the docs site show the Homebrew command beside `curl | sh`.

## Settled

- **Wrapper around the install script**: Homebrew installs the Brew entry command, and the app stays in the home folder, so
  [ADR 0004](../adr/0004-secrets-in-keychain.md)'s version-folder check, launchd and the app's own update stay as they
  are. A formula cannot write to the home folder while it installs, which is why the first run installs the app.
- **What the formula stages**: the tarball (downloaded without unpacking), a `checksums.txt` line made from its
  sha256, and the install script taken from the tarball, side by side in one folder. The Brew entry command runs that
  script with the release folder set to that folder, as the release workflow's own check does.
- **Install script variable**: one new variable makes the install script skip the `~/.local/bin` link and the PATH hint.
  The Brew entry command sets it for the installs it starts. Without it the script behaves as today.
- **Restart on upgrade**: the old version's `status` tells whether the daemon runs. After the install, the new
  version's `stop` and `start` restart it. The CLI has no restart command, and `start` on a running daemon only reports it.
- **Tap**: a separate public repository, `narrowananth/homebrew-ops-console`, so the install command is the one above.
  The owner creates it and a fine-grained token with write access to that repository only, stored as a secret of this
  repository. Shipping this change creates nothing outside this repository.
- **Formula from a template**: this repository holds the template, the Brew entry command's script and the rendering. The
  release job renders them with the version and both sha256 values and pushes the result to the tap.
- **Check before push**: the formula is installed from a local tap (trusted with `brew trust`, which Homebrew now
  requires) before it reaches the real one, so a broken formula never goes live. The release it points at is already published when the job runs.
- **Tarball kept in the Cellar**: the first run installs with no second download and no network. The cost is a second
  copy of the app on disk, about the size of one release.
- **Never downgrade**: the Brew entry command compares versions and installs only when the installed one is older.
- **Native Homebrew only**: the formula carries one tarball per architecture, chosen by Homebrew. The install script
  picks the arm64 build in a Rosetta shell, so a Rosetta Homebrew would hand it the wrong tarball.
- **License and description**: MIT, from the repository's license, and the description the site uses.

## Not required

- **Two first runs at once**: the second may fail or reinstall. The operator runs it again.
- **A tap ahead of a manual install**: the Brew entry command never touches an app newer than the formula.
- **Removing the app on `brew uninstall`**: Homebrew gives a formula no uninstall hook, so the operator runs
  `ops-console uninstall`.
- **A Homebrew cask or the core repository**: the tap is the install route. A listing in Homebrew's own repository
  is a later request.
- **`brew upgrade` upgrading the app itself**: it upgrades the Brew entry command, and the app follows on the next command.
- **A link that shadows the Brew entry command**: an app update recreates the `~/.local/bin` link. The operator who wants
  the version check on every command removes that link.

## Safety

No change. The agent's reach is the same as before. The Brew entry command and the tap run outside any agent run, and no
Connection is touched.

## Database

No change.

## API

No change.

## UI

No change. The in-app update card installs through the install script as before.

## Rejected

- **App in the Cellar**: native to Homebrew, but breaks ADR 0004's version-folder check, moves launchd's target on every
  upgrade, and needs the app's own update turned off for brew installs.
- **Entry command that downloads from GitHub at run time**: no second copy on disk, but the checksum would come from
  the same server as the file, and a first run offline would fail.
- **Formula folder in this repository**: no second repository or token, but users must tap with a full URL and a release
  must commit back to `main`.
- **Cask**: casks install apps, and a download through one adds the quarantine flag the unsigned build cannot pass.
- **Run the install from `post_install`**: Homebrew's sandbox blocks writes to the home folder there.
- **Check the formula after the push**: a broken formula would be live before anything looked at it.

## Glossary

- **Brew entry command**: the `ops-console` command Homebrew installs. It installs the matching app into the home
  folder on first run and after an upgrade, then runs the command typed.
- **Tap**: the repository that holds the console's Homebrew formula.

## ADR

- **Homebrew installs an entry command around the install script**: the app keeps its home-folder layout, launchd job
  and self-update, so a Homebrew install and a script install behave the same after the first run. The trade-off: a
  second copy of the release in the Cellar, an app that updates itself past its formula, and no removal of the app on
  `brew uninstall`. It is hard to undo once operators run the Brew entry command, since a move to the Cellar changes where
  launchd points.

## Seams

- **Entry command with a fake install script and a fake installed command (unit, shell run from a test)**: 2 to 6, 9
  to 11. Cases: no install, older install, equal, newer, `update` and `uninstall` with and without an app, arguments,
  stdin and exit code passed through, the install failing, a running daemon restarted, and a Rosetta Homebrew.
- **Install script (cli, `install.test.ts`)**: 8 and 16, with the existing checksum-mismatch case; 11's skipped link
  and hint with the new variable set.
- **Formula rendering from the template (unit)**: 1. The version, both URLs and both sha256 values appear, the install
  step stages a Cellar the Brew entry command installs from, and it writes nothing under the home folder.
- **Tap job on a release (CI)**: 13 and 14. Local-tap install, `brew audit --strict`, `brew style` and the formula's
  test run before the push.
- **Manual on a clean Mac**: 1, 7 and 12. Install through brew, run `ops-console start`, `ops-console update`, then
  `brew uninstall` and check the app is still there.
- **Review**: 15 for secrets, and 17 for the README and site text.

## Out of scope

- **Signed and notarized builds**: [sign-and-notarize-release](sign-and-notarize-release.md), on hold.
- **Linux package managers**: with Linux support, in their own spec.
- **Winget and npm**: with Windows and Linux.
- **Listing in Homebrew's core repository**: after the tap has users.
