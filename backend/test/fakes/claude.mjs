#!/usr/bin/env node
// Stands in for the `claude` CLI: prints output in its format and records add/remove calls.
// Sign-in state lives in `fake-auth.json` in the config dir: `CLAUDE_CONFIG_DIR`, or `FAKE_CLAUDE_HOME` for the
// operator's own setup. `mcp add` and `remove` edit `.claude.json` there, in Claude Code's shape. `mcp login` records
// the server in `fake-mcp-auth.json`; `mcp-fail-add` in the dir makes `mcp add` fail, `FAKE_MCP_LOGIN=fail` makes login fail.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const [, , group, command, ...rest] = process.argv;
const here = path.dirname(new URL(import.meta.url).pathname);
const warning =
  '⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set · Unset it to load them';

if (group === '--agent') {
  // The Dev tools setup agent: prints each line it hears, and `tool <name> <json>` calls the console's tool endpoint.
  const { OPS_CONSOLE_URL: url, OPS_CONSOLE_TOKEN: token, OPS_CONSOLE_TERMINAL: terminal } = process.env;
  console.log('setup agent ready');
  createInterface({ input: process.stdin }).on('line', async (line) => {
    const call = /^tool (\w+) (.*)$/.exec(line);
    if (!call) {
      console.log(`heard: ${line}`);
      return;
    }
    const response = await fetch(`${url}/api/terminals/${terminal}/tools/${call[1]}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: call[2],
    });
    console.log(`result: ${response.status} ${JSON.stringify(await response.json())}`);
  });
  await new Promise(() => {});
}

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
  if (command === 'login') {
    // `FAKE_LOGIN` is `fail`, `hang`, or the email to sign in as.
    const mode = process.env.FAKE_LOGIN ?? 'login@example.com';
    if (mode === 'fail') process.exit(1);
    if (mode === 'hang') {
      setInterval(() => {}, 1000);
      process.on('SIGTERM', () => process.exit(143));
      // Waits like the real CLI, instead of falling through to the exit below.
      await new Promise(() => {});
    } else {
      writeFileSync(auth, JSON.stringify({ email: mode, subscriptionType: 'pro' }));
      process.exit(0);
    }
  } else {
    if (command === 'logout') {
      rmSync(auth, { force: true });
      process.exit(0);
    }
    process.exit(2);
  }
} else if (group !== 'mcp') {
  process.exit(2);
}

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
  if (process.env.FAKE_CLAUDE_RECORD)
    appendFileSync(process.env.FAKE_CLAUDE_RECORD, `${JSON.stringify([command, ...rest])}\n`);
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (dir) {
    if (command === 'add' && existsSync(path.join(dir, 'mcp-fail-add'))) process.exit(1);
    const file = path.join(dir, '.claude.json');
    const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    const scopeAt = rest.indexOf('--scope');
    const scope = scopeAt === -1 ? 'local' : rest[scopeAt + 1];
    config.projects ??= {};
    config.projects[process.cwd()] ??= {};
    // Project scope is a `.mcp.json` in the working directory, shared by every account.
    const projectFile = path.join(process.cwd(), '.mcp.json');
    const project =
      scope === 'project' ? (existsSync(projectFile) ? JSON.parse(readFileSync(projectFile, 'utf8')) : {}) : null;
    const holder = project ?? (scope === 'user' ? config : config.projects[process.cwd()]);
    holder.mcpServers ??= {};
    if (command === 'remove') {
      delete holder.mcpServers[rest[0]];
    } else {
      const dash = rest.indexOf('--');
      const options = dash === -1 ? rest : rest.slice(0, dash);
      const flag = (name) => {
        const at = options.indexOf(name);
        return at === -1 ? undefined : options[at + 1];
      };
      const headers = {};
      options.forEach((arg, at) => {
        if (arg === '--header') {
          const [key, ...value] = options[at + 1].split(': ');
          headers[key] = value.join(': ');
        }
      });
      const positional = options.filter(
        (arg, at) => !arg.startsWith('-') && !['--scope', '--transport', '--header'].includes(options[at - 1]),
      );
      const name = positional[0];
      holder.mcpServers[name] =
        dash === -1
          ? { type: flag('--transport'), url: positional[1], headers }
          : { type: 'stdio', command: rest[dash + 1], args: rest.slice(dash + 2), env: {} };
    }
    if (project) writeFileSync(projectFile, JSON.stringify(project, null, 2));
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(config, null, 2));
  }
} else if (command === 'login' || command === 'logout') {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'fake-mcp-auth.json');
  const names = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  if (command === 'login') {
    if (process.env.FAKE_MCP_LOGIN === 'fail') process.exit(1);
    writeFileSync(file, JSON.stringify([...names, rest[0]]));
  } else {
    writeFileSync(file, JSON.stringify(names.filter((name) => name !== rest[0])));
  }
} else {
  process.exit(2);
}
