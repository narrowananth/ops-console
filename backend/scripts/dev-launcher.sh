#!/bin/sh
# Stands in for the installed `ops-console` command in development: `mcp-exec` and `mcp-setup` run from source.
# It runs on the dev app's Node when `pnpm dev` built one, as the installed launcher runs on the app's, so the
# Keychain items the daemon holds open for it without asking.
dir=$(dirname "$0")
node="$dir/../.data/Ops Console (dev).app/Contents/MacOS/Ops Console (dev)"
[ -x "$node" ] || node=node
# Claude starts it from the session's folder, so tsx is told where the backend's tsconfig is (Nest's decorators).
exec "$node" "$dir/../node_modules/tsx/dist/cli.mjs" --tsconfig "$dir/../tsconfig.json" "$dir/../src/main.ts" "$@"
