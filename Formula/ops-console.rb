class OpsConsole < Formula
  desc "Local web console for production ops on top of Claude Code"
  homepage "https://opsconsole.org"
  license "MIT"

  depends_on :macos

  on_macos do
    on_arm do
      url "https://github.com/narrowananth/ops-console/releases/download/v0.1.62/ops-console-darwin-arm64.tar.gz",
          using: :nounzip
      sha256 "9eaab68976c770387bf84f749f9117edd4b6c7e56367a0102bdf3e09786d01a5"
    end

    on_intel do
      url "https://github.com/narrowananth/ops-console/releases/download/v0.1.62/ops-console-darwin-x64.tar.gz",
          using: :nounzip
      sha256 "66af38ec18a776f7fc40dff77bd456223bf42e04c98e06f473d66a5af82d48cc"
    end
  end

  def install
    tarball = Dir["ops-console-darwin-*.tar.gz"].first
    release = libexec/"release"
    release.install tarball
    # install.sh reads the release folder: the tarball, its checksum line and the script itself.
    system "tar", "-xzf", release/tarball, "-C", release, "./install.sh"
    (release/"checksums.txt").write "#{Digest::SHA256.file(release/tarball).hexdigest}  #{tarball}\n"
    (libexec/"VERSION").write "#{version}\n"
    (bin/"ops-console").write <<~'ENTRY'
      #!/bin/sh
      # The ops-console command Homebrew installs. It installs the formula's version of the app into ~/.ops-console, then
      # runs the installed command.
      set -eu
      self=$0
      while [ -L "$self" ]; do
        target=$(readlink "$self")
        case $target in
          /*) self=$target ;;
          *) self=$(dirname "$self")/$target ;;
        esac
      done
      prefix=$(cd "$(dirname "$self")/.." && pwd -P)
      release=$prefix/libexec/release
      formula_version=$(cat "$prefix/libexec/VERSION")
      installed_cli=$HOME/.ops-console/current/bin/ops-console

      say() { echo "ops-console: $*" >&2; }

      newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]; }

      installed=$(cat "$HOME/.ops-console/current/VERSION" 2>/dev/null || true)
      command=${1:-}
      if [ -z "$installed" ] && [ "$command" = uninstall ]; then
        say "ops-console is not installed; nothing to remove"
        exit 0
      fi

      # update and uninstall act on the installed app as it is, so an older app is not first upgraded to the formula's.
      check=1
      if [ -n "$installed" ]; then
        case $command in update | uninstall) check= ;; esac
      fi

      if [ -n "$check" ] && { [ -z "$installed" ] || newer "$formula_version" "$installed"; }; then
        # The install script picks the arm64 build in a Rosetta shell, but an Intel Homebrew on an Apple silicon Mac holds
        # the x64 tarball.
        if ls "$release"/ops-console-darwin-x64.tar.gz >/dev/null 2>&1 && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
          say "this Homebrew is the Intel one; install the native Homebrew in /opt/homebrew and run brew install again"
          exit 1
        fi
        running=
        if [ -n "$installed" ] && "$installed_cli" status >/dev/null 2>&1; then running=1; fi
        say "installing $formula_version"
        OPS_CONSOLE_RELEASE_URL=file://$release OPS_CONSOLE_NO_LINK=1 sh "$release/install.sh" || exit $?
        if [ -n "$running" ]; then
          # The new version's CLI: the CLI has no restart, and start on a running daemon only reports it.
          "$installed_cli" stop >&2
          "$installed_cli" start >&2
        fi
      fi

      export OPS_CONSOLE_NO_LINK=1
      exec "$installed_cli" "$@"
    ENTRY
    chmod 0755, bin/"ops-console"
  end

  def caveats
    <<~EOS
      Start the console:
        ops-console start && ops-console open

      The first ops-console command installs the app into ~/.ops-console. To remove the app,
      run `ops-console uninstall` before `brew uninstall ops-console`. Your data and logs stay.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/ops-console --version")
  end
end
