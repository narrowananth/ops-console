#!/usr/bin/env node
// Stands in for the `claude` CLI: prints output in its format and records add/remove calls.
// Sign-in state lives in `fake-auth.json` in the config dir: `CLAUDE_CONFIG_DIR`, or `FAKE_CLAUDE_HOME` for the
// operator's own setup.
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const [, , group, command, ...rest] = process.argv;
const here = path.dirname(new URL(import.meta.url).pathname);
const warning =
  '⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set · Unset it to load them';

if (group === 'auth') {
  const auth = path.join(process.env.CLAUDE_CONFIG_DIR ?? process.env.FAKE_CLAUDE_HOME, 'fake-auth.json');
  if (command === 'status') {
    const signedIn = existsSync(auth);
    const account = signedIn ? JSON.parse(readFileSync(auth, 'utf8')) : {};
    console.log(
      JSON.stringify({ loggedIn: signedIn, authMethod: signedIn ? 'claude.ai' : 'none', ...account }, null, 2),
    );
    process.exit(signedIn ? 0 : 1);
  }
  if (command === 'logout') {
    rmSync(auth, { force: true });
    process.exit(0);
  }
  process.exit(2);
}

if (group !== 'mcp') process.exit(2);

if (command === 'list') {
  console.log(`${warning}
Checking MCP server health...

fake-stdio: ${process.execPath} ${here}/mcp-server.mjs - ✓ Connected
sentry: https://mcp.sentry.dev/mcp (HTTP) - ⚠ Needs authentication
pg-prod: npx -y @example/pg-mcp - ✗ Failed to connect
`);
} else if (command === 'get' && rest[0] === 'fake-stdio') {
  console.log(`${warning}
fake-stdio:
  Scope: User config (available in all your projects)
  Status: ✓ Connected
  Type: stdio
  Command: ${process.execPath}
  Args: ${here}/mcp-server.mjs
  Environment:
    GREETING=hello from env

To remove this server, run: claude mcp remove "fake-stdio" -s user
`);
} else if (command === 'get' && rest[0] === 'sentry') {
  console.log(`sentry:
  Scope: Local config (private to you in this project)
  Status: ⚠ Needs authentication
  Type: http
  URL: https://mcp.sentry.dev/mcp
  Headers:
    X-Org: example

To remove this server, run: claude mcp remove "sentry" -s local
`);
} else if (command === 'get') {
  console.error(`No MCP server found with name: ${rest[0]}`);
  process.exit(1);
} else if (command === 'add' || command === 'remove') {
  appendFileSync(process.env.FAKE_CLAUDE_RECORD, `${JSON.stringify([command, ...rest])}\n`);
} else {
  process.exit(2);
}
