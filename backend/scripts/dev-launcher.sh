#!/bin/sh
# Stands in for the installed `ops-console` command in development: `mcp-exec` and `mcp-setup` run from source.
exec "$(dirname "$0")/../node_modules/.bin/tsx" "$(dirname "$0")/../src/main.ts" "$@"
