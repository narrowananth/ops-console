# Homebrew installs an entry command around the install script

`brew install ops-console`, after `brew tap` of this repository, puts one command, the Brew entry command, in Homebrew's `bin`. The
formula also keeps the release tarball Homebrew checked, a `checksums.txt` for it and the install script from the
tarball. The first `ops-console` command on a Mac with no app, and the first one after `brew upgrade` brings a newer
formula, runs that install script against the kept tarball and installs the formula's version into `~/.ops-console`. A
running daemon is stopped and started again on the new version. Then the command runs. It never installs over a newer
app, and `update` and `uninstall` act on the installed app as it is.

The app keeps its home-folder layout, its launchd job and its own update path through the install script, so a Homebrew
install and a script install behave the same after the first run, and [ADR 0004](0004-secrets-in-keychain.md)'s
check of the previous version folder holds. A formula cannot write to the home folder while it installs, which is why
the first run installs the app. The Brew entry command sets `OPS_CONSOLE_NO_LINK` for every command it runs, so its installs, `update` included, make no `~/.local/bin`
link, which would otherwise shadow it and stop `brew upgrade` from reaching the app. A link made earlier, or by the app's
own update, still works and skips the version check.

The tap is this repository: `Formula/ops-console.rb` on `main`, tapped with the repository's URL. The release workflow
renders the formula from a template, installs it from a local tap and runs `brew audit --strict`, `brew style` and the
formula's test, and only then commits it to `main`. The formula carries one tarball per architecture, and a Rosetta Homebrew on an
Apple silicon Mac is refused, since the install script would pick the arm64 build there.

The trade-offs: a second copy of the release in the Cellar, an app that updates itself past its formula, and no removal
of the app on `brew uninstall`, since Homebrew gives a formula no uninstall hook. A move to an app in the Cellar would
change where launchd points, so this is hard to undo once operators run the Brew entry command.

## Considered Options

- **App in the Cellar**: native to Homebrew, but breaks ADR 0004's version-folder check, moves launchd's target on every
  upgrade, and needs the app's own update turned off for brew installs.
- **Entry command that downloads from GitHub at run time**: no second copy on disk, but the checksum would come from the
  same server as the file, and a first run offline would fail.
- **A separate tap repository**: gives the short `brew install narrowananth/ops-console/ops-console`, but needs a second
  public repository and a fine-grained token stored as a secret.
- **Cask**: casks install apps, and a download through one adds the quarantine flag the unsigned build cannot pass.
- **Install from `post_install`**: Homebrew's sandbox blocks writes to the home folder there.
