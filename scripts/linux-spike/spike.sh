#!/usr/bin/env bash
# Linux spike for docs/specs/linux-port.md, Behavior item 1. Run it on each system the spec names (Ubuntu LTS, Debian
# stable, Fedora, WSL2), once in a desktop session and once over a headless SSH login:
#   bash scripts/linux-spike/spike.sh
# It writes spike-results-<host>-<date>.md in the current folder. It prints no secret: environment variables appear by
# name, the D-Bus address by socket path, JSON files by top-level key names, and the keyring test uses its own item.
# It drives `bwrap` directly, as a stand-in for the Agent SDK's Linux sandbox; whether the SDK's own profile behaves
# the same is the second stage in docs/linux-spike.md.
set -u

if [ "$(uname -s)" != Linux ]; then
  echo "This spike runs on Linux or WSL2 only." >&2
  exit 2
fi

HOST=$(hostname -s 2>/dev/null || echo host)
OUT="spike-results-$HOST-$(date +%Y%m%d-%H%M%S).md"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ops-console-spike.XXXXXX")
trap 'rm -rf "$WORK"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null' EXIT

say() { printf '%s\n' "$*" >>"$OUT"; }
have() { command -v "$1" >/dev/null 2>&1; }
first() { head -n 1 | cut -c1-200; }
row() { say "| $1 | $2 | ${3:-} |"; }
table() { say ""; say "### $1"; say ""; say "| Check | Result | Detail |"; say "| --- | --- | --- |"; }

BW=bwrap
BASE=(--ro-bind / / --dev /dev --proc /proc)

# A bus probe that connects to the session bus socket and reports whether it answered.
probe_py='
import os, re, socket, sys
addr = os.environ.get("DBUS_SESSION_BUS_ADDRESS", "")
m = re.search(r"unix:path=([^,;]+)", addr)
a = re.search(r"unix:abstract=([^,;]+)", addr)
if m: target = m.group(1)
elif a: target = "\0" + a.group(1)
else: target = os.path.join(os.environ.get("XDG_RUNTIME_DIR", ""), "bus")
s = socket.socket(socket.AF_UNIX)
s.settimeout(3)
try:
    s.connect(target); print("reachable")
except Exception as e:
    print("blocked: " + type(e).__name__ + " " + str(e)[:80])
'

: >"$OUT"
say "# Linux spike results"
say ""
say "Run on: $(date -u +%Y-%m-%dT%H:%M:%SZ). No secret values are in this file."

# ---------------------------------------------------------------- system
table "System"
row "os" "$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
row "kernel" "$(uname -r)"
row "wsl" "$(grep -qi microsoft /proc/version 2>/dev/null && (grep -qi wsl2 /proc/version && echo WSL2 || echo 'WSL1 (or unknown)') || echo no)"
row "arch" "$(uname -m)"
row "glibc" "$(ldd --version 2>&1 | first)"
row "bwrap" "$($BW --version 2>&1 | first)"
row "socat" "$(have socat && socat -V 2>&1 | sed -n 2p | cut -c1-100 || echo missing)"
row "unprivileged userns (apparmor)" "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>&1 | first)"
row "max_user_namespaces" "$(sysctl -n user.max_user_namespaces 2>&1 | first)"
row "systemd user manager" "$(systemctl --user show-environment >/dev/null 2>&1 && echo yes || echo no)"
row "lingering" "$(loginctl show-user "$USER" --property=Linger --value 2>&1 | first)"
row "session type" "${XDG_SESSION_TYPE:-none}; DISPLAY set: $([ -n "${DISPLAY:-}" ] && echo yes || echo no); WAYLAND_DISPLAY set: $([ -n "${WAYLAND_DISPLAY:-}" ] && echo yes || echo no)"
row "folder dialog" "zenity: $(have zenity && echo yes || echo no); kdialog: $(have kdialog && echo yes || echo no)"
row "lsof / ps / xdg-open" "$(have lsof && echo lsof || echo no-lsof) $(have ps && echo ps || echo no-ps) $(have xdg-open && echo xdg-open || echo no-xdg-open)"

if ! have bwrap; then
  say ""
  say "bwrap is not installed: the sandbox sections are skipped. Install bubblewrap and socat, then run again."
  echo "wrote $OUT (bwrap missing)"
  exit 0
fi
if ! $BW "${BASE[@]}" true 2>"$WORK/bwrap.err"; then
  say ""
  say "bwrap cannot start here: \`$(first <"$WORK/bwrap.err")\`. The sandbox sections are skipped."
  echo "wrote $OUT (bwrap cannot start)"
  exit 0
fi

# ---------------------------------------------------------------- secret service
table "Secret Service: can a sandboxed command reach it?"
SOCKET=$(printf '%s' "${DBUS_SESSION_BUS_ADDRESS:-}" | sed -n 's/.*unix:path=\([^,;]*\).*/\1/p')
[ -n "$SOCKET" ] || SOCKET="${XDG_RUNTIME_DIR:-}/bus"
row "DBUS_SESSION_BUS_ADDRESS" "$([ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] && printf '%s' "$DBUS_SESSION_BUS_ADDRESS" | sed 's/guid=.*//' || echo unset)" "socket used below: $SOCKET"
row "keyring socket folder" "$(ls -d "${XDG_RUNTIME_DIR:-/nonexistent}/keyring" 2>/dev/null || echo none)" "contents: $(ls "${XDG_RUNTIME_DIR:-/nonexistent}/keyring" 2>/dev/null | tr '\n' ' ')"
row "abstract unix sockets on the host" "$(have ss && ss -xl 2>/dev/null | grep -c ' @' || echo 'ss missing')" "count of listening sockets whose name starts with @"
row "host reaches the bus" "$(python3 -c "$probe_py" 2>&1 | first)"
row "V1 plain read-only view" "$($BW "${BASE[@]}" python3 -c "$probe_py" 2>&1 | first)"
row "V2 with --unshare-net" "$($BW "${BASE[@]}" --unshare-net python3 -c "$probe_py" 2>&1 | first)" "does the network namespace isolate abstract sockets?"
row "V3 tmpfs over XDG_RUNTIME_DIR" "$($BW "${BASE[@]}" --tmpfs "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" python3 -c "$probe_py" 2>&1 | first)"
row "V4 /dev/null bound over the socket path" "$([ -S "$SOCKET" ] && $BW "${BASE[@]}" --ro-bind /dev/null "$SOCKET" python3 -c "$probe_py" 2>&1 | first || echo 'no socket at that path')" "a denyRead on the socket path"
row "V5 DBUS_SESSION_BUS_ADDRESS unset" "$($BW "${BASE[@]}" --unsetenv DBUS_SESSION_BUS_ADDRESS python3 -c "$probe_py" 2>&1 | first)" "falls back to XDG_RUNTIME_DIR/bus"
row "V6 V3 plus V5 together" "$($BW "${BASE[@]}" --tmpfs "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" --unsetenv DBUS_SESSION_BUS_ADDRESS python3 -c "$probe_py" 2>&1 | first)"
if have secret-tool; then
  row "secret-tool lookup, host" "exit $(secret-tool lookup ops-console-spike none >/dev/null 2>"$WORK/st.err"; echo $?)" "stderr: $(first <"$WORK/st.err")"
  row "secret-tool lookup, V1" "exit $($BW "${BASE[@]}" secret-tool lookup ops-console-spike none >/dev/null 2>"$WORK/st.err"; echo $?)" "stderr: $(first <"$WORK/st.err")"
  row "secret-tool lookup, V6" "exit $($BW "${BASE[@]}" --tmpfs "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" --unsetenv DBUS_SESSION_BUS_ADDRESS secret-tool lookup ops-console-spike none >/dev/null 2>"$WORK/st.err"; echo $?)" "stderr: $(first <"$WORK/st.err")"
else
  row "secret-tool" "not installed" "libsecret-tools gives a second, higher-level probe"
fi

# ---------------------------------------------------------------- keyring library
table "@napi-rs/keyring and the error strings the console must tell apart"
APP="$HOME/.ops-console/current/app"
NODE="$HOME/.ops-console/current/node/bin/node"
[ -x "$NODE" ] || NODE=$(command -v node || true)
if [ -n "$NODE" ] && [ -d "$APP/node_modules/@napi-rs" ]; then
  row "keyring packages" "$(ls "$APP/node_modules/@napi-rs" | tr '\n' ' ')"
  KEYTEST='
const { Entry } = require("@napi-rs/keyring");
const pinned = process.env.SPIKE_STORE || "secret-service";
let e;
try { e = new Entry("ops-console-spike", "probe", pinned === "default" ? undefined : { linux: { store: pinned } }); }
catch (err) { console.log("open: ERROR " + String(err && err.message).split("\n")[0].slice(0, 200)); process.exit(0); }
const step = (name, fn) => { try { const v = fn(); console.log(name + ": ok" + (name === "get" && v !== null && v !== undefined ? (v === "spike-value" ? " (value matches)" : " (value differs)") : "")); } catch (err) { console.log(name + ": ERROR " + String(err && err.message).split("\n")[0].slice(0, 200)); } };
step("set", () => e.setPassword("spike-value"));
step("get", () => e.getPassword());
step("delete", () => e.deletePassword());
step("get after delete", () => e.getPassword());
'
  row "round trip, pinned to the Secret Service (what the console does)" "$(cd "$APP" && "$NODE" -e "$KEYTEST" 2>&1 | tr '\n' ';')"
  row "round trip, pinned, no D-Bus session" "$(cd "$APP" && env -u DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR=/nonexistent "$NODE" -e "$KEYTEST" 2>&1 | tr '\n' ';')" "the error text for \"no Secret Service\": the pinned store should throw at open; paste it into NO_SERVICE in keychain.ts if it does not match"
  row "round trip, NOT pinned, no D-Bus session" "$(cd "$APP" && env -u DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR=/nonexistent SPIKE_STORE=default "$NODE" -e "$KEYTEST" 2>&1 | tr '\n' ';')" "expected to succeed into the kernel keyring: this is the fallback the console avoids by pinning"
  say ""
  say "By hand, to record the two other strings: lock the keyring (or log out of the desktop and back in without unlocking), then run \`cd $APP && $NODE -e '$(printf '%s' "$KEYTEST" | tr '\n' ' ')'\`. Note the error when the unlock prompt is dismissed, and the one when it is denied."
else
  row "keyring library" "not testable" "needs an installed console ($APP) or node with @napi-rs/keyring"
fi

# ---------------------------------------------------------------- localhost
table "localhost and ports"
if have python3; then
  PORT=$((20000 + RANDOM % 20000))
  python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
  SERVER_PID=$!
  sleep 1
  fetch="python3 -c \"import urllib.request,sys; print(urllib.request.urlopen('http://127.0.0.1:$PORT',timeout=3).status)\""
  row "host server reached from the host" "$(eval "$fetch" 2>&1 | first)"
  row "host server reached from bwrap (shared net)" "$($BW "${BASE[@]}" sh -c "$fetch" 2>&1 | first)" "a database tunnel on localhost"
  row "host server reached from bwrap --unshare-net" "$($BW "${BASE[@]}" --unshare-net sh -c "$fetch" 2>&1 | first)" "the SDK documents a private localhost on Linux"
  row "server and client in one bwrap --unshare-net" "$($BW "${BASE[@]}" --unshare-net sh -c "python3 -m http.server 34567 --bind 127.0.0.1 >/dev/null 2>&1 & sleep 1; python3 -c \"import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:34567',timeout=3).status)\"" 2>&1 | first)" "a test that starts its own server"
  row "server in one bwrap, client in a second" "n/a by construction" "each command gets its own namespace with --unshare-net; with shared net they see each other"
else
  row "localhost" "skipped" "python3 missing"
fi

# ---------------------------------------------------------------- docker
table "Docker and Testcontainers"
if have docker; then
  row "docker info on the host" "$(docker info --format '{{.ServerVersion}}' 2>&1 | first)"
  row "docker info in bwrap (read-only view)" "$($BW "${BASE[@]}" docker info --format '{{.ServerVersion}}' 2>&1 | first)"
  row "docker info in bwrap --unshare-net" "$($BW "${BASE[@]}" --unshare-net docker info --format '{{.ServerVersion}}' 2>&1 | first)" "the socket path is reachable, but network-less commands cannot reach published ports"
  say ""
  say "By hand: run a Testcontainers suite (or \`docker run --rm -p 8080:80 nginx\` and a request to localhost:8080) inside the SDK sandbox and note whether it needs \`excludedCommands\`."
else
  row "docker" "not installed" ""
fi

# ---------------------------------------------------------------- git placeholders
table "git control files: placeholders for paths that do not exist"
if have git; then
  git config --global --get user.name >/dev/null 2>&1 || export GIT_AUTHOR_NAME=spike GIT_AUTHOR_EMAIL=spike@example.com GIT_COMMITTER_NAME=spike GIT_COMMITTER_EMAIL=spike@example.com
  REPO="$WORK/repo"
  git init -q -b main "$REPO" && git -C "$REPO" commit -q --allow-empty -m init
  git -C "$REPO" worktree add -q "$WORK/wt" -b side 2>/dev/null
  cd "$REPO" || exit 1
  # The console denies writes to these; a path that does not exist gets an empty read-only placeholder.
  PLACEHOLDERS=()
  for n in commondir gitdir config.worktree; do [ -e ".git/$n" ] || PLACEHOLDERS+=(--ro-bind /dev/null "$REPO/.git/$n"); done
  inrepo() { $BW "${BASE[@]}" --bind "$WORK" "$WORK" "${PLACEHOLDERS[@]}" --chdir "$REPO" "$@" 2>&1 | first; }
  row "plain checkout: git status" "$(inrepo git status --short | cat)$(inrepo git rev-parse --git-dir)"
  row "plain checkout: git commit" "$(inrepo git commit --allow-empty -m spike)"
  row "plain checkout: git worktree add" "$(inrepo git worktree add -q "$WORK/wt2" -b side2)"
  cd "$WORK/wt" || exit 1
  WTP=(); GITDIR=$(git rev-parse --git-dir)
  for n in commondir gitdir config.worktree; do [ -e "$GITDIR/$n" ] || WTP+=(--ro-bind /dev/null "$GITDIR/$n"); done
  inwt() { $BW "${BASE[@]}" --bind "$WORK" "$WORK" "${WTP[@]}" --chdir "$WORK/wt" "$@" 2>&1 | first; }
  row "Session worktree: git status" "$(inwt git status --short | cat)$(inwt git rev-parse --git-dir)"
  row "Session worktree: git commit" "$(inwt git commit --allow-empty -m spike)"
  cd "$WORK" || exit 1
  say ""
  say "A failure here means the sandbox's placeholder for a missing control file breaks git; \`gitControl()\` in run-sandbox.ts must then deny only the files that exist."
else
  row "git" "not installed" ""
fi

# ---------------------------------------------------------------- Go TLS and gh
table "Go CLIs (gh) in the sandbox"
if have gh; then
  row "gh --version" "$(gh --version 2>&1 | first)"
  if [ -n "${GH_TOKEN:-}" ]; then
    row "gh api rate_limit, host" "$(gh api rate_limit --jq .rate.limit 2>&1 | first)"
    row "gh api rate_limit, bwrap (shared net)" "$($BW "${BASE[@]}" gh api rate_limit --jq .rate.limit 2>&1 | first)" "certificate check and GH_TOKEN sign-in"
  else
    row "gh api" "skipped" "export GH_TOKEN to test the token sign-in"
  fi
else
  row "gh" "not installed" ""
fi

# ---------------------------------------------------------------- Claude Code's sign-in
table "Where Claude Code keeps its MCP sign-in on Linux (key names only)"
for f in "$HOME/.claude/.credentials.json" "$HOME/.claude.json" "${XDG_CONFIG_HOME:-$HOME/.config}/claude/credentials.json" "${XDG_DATA_HOME:-$HOME/.local/share}/claude/credentials.json"; do
  if [ -f "$f" ]; then
    keys=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(",".join(sorted(d)) if isinstance(d,dict) else type(d).__name__); m=d.get("mcpOAuth") if isinstance(d,dict) else None; print("mcpOAuth entries: "+str(len(m))) if isinstance(m,dict) else None' "$f" 2>&1 | tr '\n' ' ')
    row "$f" "exists, mode $(stat -c %a "$f")" "top-level keys: $keys"
  else
    row "$f" "absent" ""
  fi
done
if have secret-tool; then
  row "Secret Service item named Claude Code-credentials" "$(secret-tool search service 'Claude Code-credentials' >/dev/null 2>&1 && echo present || echo absent)" "log in to an MCP server through Claude Code first, then run again"
fi

# ---------------------------------------------------------------- node-pty
table "node-pty"
if [ -n "$NODE" ] && [ -d "$APP/node_modules/node-pty" ]; then
  row "prebuilds" "$(ls "$APP/node_modules/node-pty/prebuilds" 2>/dev/null | tr '\n' ' ' || echo none)"
  row "build/Release" "$(ls "$APP/node_modules/node-pty/build/Release" 2>/dev/null | tr '\n' ' ' || echo none)" "a compiled pty.node here means it was built at install"
  row "loads and spawns a pty" "$(cd "$APP" && "$NODE" -e "const p=require('node-pty');const t=p.spawn('/bin/echo',['pty-ok'],{});t.onData(d=>console.log(d.trim()));t.onExit(()=>process.exit(0))" 2>&1 | first)"
else
  row "node-pty" "not testable" "needs an installed console"
fi

say ""
say "## Notes for the person running this"
say ""
say "- Run it again over a headless SSH login with no desktop session and compare the Secret Service and folder dialog rows."
say "- Paste this file into docs/linux-spike.md under the system's name."
echo "wrote $OUT"
