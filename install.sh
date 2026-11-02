#!/bin/sh
# Installs ops-console for the current user: curl -fsSL <install url> | sh
#
# OPS_CONSOLE_VERSION       install this version instead of the latest release
# OPS_CONSOLE_RELEASE_URL   fetch the release files from this folder instead of GitHub
#
# Needs no sudo and writes only under $HOME.
set -eu

repo=narrowananth/ops-console
install_dir=$HOME/.ops-console
bin_dir=$HOME/.local/bin

fail() {
  echo "ops-console install: $*" >&2
  exit 1
}

os=$(uname -s)
cpu=$(uname -m)
# A shell running under Rosetta reads x86_64 on an Apple silicon Mac: install the arm64 build there.
if [ "$os/$cpu" = Darwin/x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  cpu=arm64
fi
case "$os/$cpu" in
  Darwin/arm64) arch=arm64 ;;
  Darwin/x86_64) arch=x64 ;;
  *) fail "unsupported platform $os $cpu; ops-console runs on macOS on Apple silicon or Intel" ;;
esac

# The bundled Node and its native modules are built for macOS 13.5 and later.
macos=$(sw_vers -productVersion)
major=$(echo "$macos" | cut -d. -f1)
minor=$(echo "$macos.0" | cut -d. -f2)
if [ "$major" -lt 13 ] || { [ "$major" -eq 13 ] && [ "$minor" -lt 5 ]; }; then
  fail "ops-console needs macOS 13.5 or later; this Mac runs $macos"
fi

if [ -n "${OPS_CONSOLE_RELEASE_URL:-}" ]; then
  base=$OPS_CONSOLE_RELEASE_URL
elif [ -n "${OPS_CONSOLE_VERSION:-}" ]; then
  base=https://github.com/$repo/releases/download/v$OPS_CONSOLE_VERSION
else
  base=https://github.com/$repo/releases/latest/download
fi
tarball=ops-console-darwin-$arch.tar.gz

mkdir -p "$install_dir/versions"
work=$(mktemp -d "$install_dir/.install.XXXXXX")
trap 'rm -rf "$work"' EXIT

echo "Downloading $tarball"
curl -fsSL "$base/$tarball" -o "$work/$tarball" || fail "could not download $base/$tarball"
curl -fsSL "$base/checksums.txt" -o "$work/checksums.txt" || fail "could not download $base/checksums.txt"

expected=$(awk -v file="$tarball" '$2 == file { print $1 }' "$work/checksums.txt")
[ -n "$expected" ] || fail "checksums.txt has no entry for $tarball"
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$work/$tarball" | awk '{ print $1 }')
else
  actual=$(sha256sum "$work/$tarball" | awk '{ print $1 }')
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch for $tarball; nothing was installed"

mkdir "$work/unpacked"
tar -xzf "$work/$tarball" -C "$work/unpacked"
version=$(cat "$work/unpacked/VERSION")
[ -n "$version" ] || fail "$tarball has no VERSION"

previous=
if [ -L "$install_dir/current" ]; then
  previous=$(basename "$(readlink "$install_dir/current")")
fi

rm -rf "$install_dir/versions/$version"
mv "$work/unpacked" "$install_dir/versions/$version"
ln -sfn "versions/$version" "$install_dir/current"

mkdir -p "$bin_dir"
ln -sfn "$install_dir/current/bin/ops-console" "$bin_dir/ops-console"

# Reinstalling the current version leaves the previous one in place.
if [ "$previous" != "$version" ]; then
  for dir in "$install_dir"/versions/*; do
    name=$(basename "$dir")
    if [ "$name" != "$version" ] && [ "$name" != "$previous" ]; then
      rm -rf "$dir"
    fi
  done
fi

echo "Installed ops-console $version"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    echo "$bin_dir is not on your PATH. Add this line to your shell profile:"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac
echo "Run: ops-console start && ops-console open"
