#!/usr/bin/env node
// Stands in for the `claude` CLI: prints output in its format and records add/remove calls.
// Sign-in state lives in `fake-auth.json` in the config dir: `CLAUDE_CONFIG_DIR`, or `FAKE_CLAUDE_HOME` for the
// operator's own setup. `mcp add` and `remove` edit `.claude.json` there, in Claude Code's shape. `mcp login` records
// the server in `fake-mcp-auth.json`; `mcp-fail-add` in the dir makes `mcp add` fail, `FAKE_MCP_LOGIN=fail` makes login fail, `hang` makes it wait,
// and login without a terminal fails as the real one does.
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
  const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
  console.log(`setup agent on ${flag('--model')} at ${flag('--effort')} effort`);
  console.log(`setup agent allows ${flag('--allowedTools')}`);
  console.log('setup agent ready');
  // A bracketed paste arrives as several lines, its own breaks among them; it is heard as one.
  let pasted = null;
  createInterface({ input: process.stdin }).on('line', async (line) => {
    if (pasted !== null || line.startsWith('\x1b[200~')) {
      pasted = [...(pasted ?? []), line.replace('\x1b[200~', '')];
      if (!line.includes('\x1b[201~')) return;
      console.log(`heard pasted: ${pasted.join(' | ').replace('\x1b[201~', '')}`);
      pasted = null;
      return;
    }
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
    // `FAKE_LOGIN` is `fail`, `hang`, `code:<email>` (signs in as <email> on the code `good#fake-state`), or the
    // email to sign in as. `BROWSER` goes to `fake-login-browser.txt`, for the test to see whether a tab opened.
    const mode = process.env.FAKE_LOGIN ?? 'login@example.com';
    writeFileSync(path.join(path.dirname(auth), 'fake-login-browser.txt'), process.env.BROWSER ?? '');
    process.stdout.write(
      "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.example.com/oauth/authorize?code=true&state=fake-state\nPaste code here if prompted > ",
    );
    if (mode === 'fail') process.exit(1);
    if (mode === 'hang') {
      setInterval(() => {}, 1000);
      process.on('SIGTERM', () => process.exit(143));
      // Waits like the real CLI, instead of falling through to the exit below.
      await new Promise(() => {});
    } else if (mode.startsWith('code:')) {
      process.on('SIGTERM', () => process.exit(143));
      const lines = createInterface({ input: process.stdin });
      for await (const line of lines) {
        if (line === 'good#fake-state') {
          writeFileSync(auth, JSON.stringify({ email: mode.slice('code:'.length), subscriptionType: 'pro' }));
          process.exit(0);
        }
        console.log(
          "Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.",
        );
        process.exit(1);
      }
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
        (arg, at) =>
          !arg.startsWith('-') &&
          !['--scope', '--transport', '--header', '--client-id', '--callback-port'].includes(options[at - 1]),
      );
      const name = positional[0];
      // As Claude Code keeps a pre-registered OAuth app.
      const oauth = flag('--client-id')
        ? { oauth: { clientId: flag('--client-id'), callbackPort: Number(flag('--callback-port')) } }
        : {};
      holder.mcpServers[name] =
        dash === -1
          ? { type: flag('--transport'), url: positional[1], headers, ...oauth }
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
    // Claude Code 2.1.3xx refuses `mcp login` without a terminal on stdin.
    if (!process.stdin.isTTY) {
      console.error(`Couldn't complete authentication for "${rest[0]}": stdin isn't a terminal`);
      process.exit(1);
    }
    if (process.env.FAKE_MCP_LOGIN === 'hang') {
      // The operator never finishes in the browser; the process waits until it is stopped.
      // The pid file lets a test count its own logins, not those of another run on the machine.
      writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, `fake-mcp-login-${rest[0]}.pid`), String(process.pid));
      setInterval(() => {}, 60_000);
    } else if (process.env.FAKE_MCP_LOGIN === 'fail') {
      console.error(`Couldn't complete authentication for "${rest[0]}": SDK auth failed: Incompatible auth server`);
      process.exit(1);
    } else writeFileSync(file, JSON.stringify([...names, rest[0]]));
  } else {
    writeFileSync(file, JSON.stringify(names.filter((name) => name !== rest[0])));
  }
} else {
  process.exit(2);
}
