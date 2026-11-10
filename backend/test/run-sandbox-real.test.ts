import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUILT_IN_NETWORK_DOMAINS } from '@ops-console/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSandbox, worktreeGitDirs } from '../src/agent/run-sandbox';
import { SeatbeltRunSandbox } from '../src/terminals/run-sandbox-gate';

/**
 * The real SDK sandbox, not a fake: Claude Code's own binary runs a Bash command under the rules `runSandbox` builds,
 * against a local stand-in for the Anthropic API that asks for that one command. macOS only (Seatbelt).
 */
const CLAUDE = existsSync(path.join(import.meta.dirname, '../node_modules/@anthropic-ai/claude-agent-sdk/package.json'))
  ? findClaude()
  : null;

function findClaude(): string | null {
  const pnpm = path.resolve(import.meta.dirname, '../../node_modules/.pnpm');
  if (!existsSync(pnpm)) return null;
  const dir = readdirSync(pnpm).find((name) => name.startsWith('@anthropic-ai+claude-agent-sdk-darwin-'));
  const binary =
    dir &&
    path.join(
      pnpm,
      dir,
      'node_modules/@anthropic-ai',
      dir.replace(/^@anthropic-ai\+/, '').replace(/@.*/, ''),
      'claude',
    );
  return binary && existsSync(binary) ? binary : null;
}

const sse = (res: ServerResponse, events: [string, object][]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
};

let api: Server;
let port = 0;
let root = '';
let data = '';
let home = '';
let scratch = '';
let checkout = '';

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'real-sandbox-'));
  data = path.join(root, 'data');
  home = path.join(root, 'home');
  scratch = path.join(data, 'scratch', 'job-1');
  checkout = path.join(root, 'checkout');
  for (const dir of [scratch, path.join(home, '.ssh'), checkout]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(data, 'runtime.json'), '{"token":"SECRET"}');
  writeFileSync(path.join(scratch, 'note.txt'), 'scratch-ok');
  writeFileSync(path.join(home, '.ssh', 'key'), 'ssh-ok');

  api = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!req.url?.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      const body = JSON.parse(raw || '{}') as {
        model: string;
        stream?: boolean;
        tools?: { name: string }[];
        messages?: unknown;
      };
      const messages = JSON.stringify(body.messages ?? []);
      const command = /RUN: ((?:[^"\\]|\\.)*)/.exec(messages)?.[1];
      const base = {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (command && body.tools?.some((tool) => tool.name === 'Bash') && !messages.includes('tool_result')) {
        sse(res, [
          ['message_start', { type: 'message_start', message: base }],
          [
            'content_block_start',
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
            },
          ],
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify({ command: JSON.parse(`"${command}"`) }),
              },
            },
          ],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }],
          ['message_stop', { type: 'message_stop' }],
        ]);
      } else {
        sse(res, [
          ['message_start', { type: 'message_start', message: base }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
          ['message_stop', { type: 'message_stop' }],
        ]);
      }
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  port = (api.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => api?.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

/** What the Bash tool printed for `command`, run in `cwd` under `sandbox` (none: no sandbox). */
function run(command: string, cwd: string, sandbox: object | null): Promise<string> {
  const prompt = `RUN: ${command.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}`;
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--settings',
    JSON.stringify(sandbox ? { sandbox } : {}),
    '--model',
    'claude-sonnet-5-5',
    '--max-turns',
    '3',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE ?? '', args, {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: 'sk-ant-fake',
        CLAUDE_CONFIG_DIR: path.join(root, 'config'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 50_000);
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      const results = out.split('\n').flatMap((line) => {
        try {
          const message = JSON.parse(line);
          const content =
            message.type === 'user' && Array.isArray(message.message?.content) ? message.message.content : [];
          return content
            .filter((block: { type: string }) => block.type === 'tool_result')
            .map((block: { content: unknown }) =>
              String(typeof block.content === 'string' ? block.content : JSON.stringify(block.content)),
            );
        } catch {
          return [];
        }
      });
      if (results.length === 0) reject(new Error(`the command did not run: ${out.slice(-400)}`));
      else resolve(results.join('\n'));
    });
  });
}

const BUILT_IN: string[] = [...BUILT_IN_NETWORK_DOMAINS];
const rules = (workingDir: string, networkDomains = BUILT_IN) =>
  runSandbox({ workingDir, dataDir: data, home, networkDomains });

describe.skipIf(process.platform !== 'darwin' || CLAUDE === null)('Run sandbox, enforced by Seatbelt', () => {
  it('reads the token with no sandbox, so the cases below prove something', async () => {
    expect(await run(`cat ${data}/runtime.json`, scratch, null)).toContain('SECRET');
  }, 60_000);

  it('cannot read runtime.json, and still reads its own scratch copy inside the data folder (Behavior 3)', async () => {
    const token = await run(`cat ${data}/runtime.json`, scratch, rules(scratch));
    expect(token).toContain('Operation not permitted');
    expect(token).not.toContain('SECRET');
    expect(await run(`cat ${scratch}/note.txt`, scratch, rules(scratch))).toContain('scratch-ok');
  }, 120_000);

  it('writes in the working folder and temp only (Behavior 2, 6)', async () => {
    expect(await run(`echo hi > ${scratch}/out.txt && cat ${scratch}/out.txt`, scratch, rules(scratch))).toContain(
      'hi',
    );
    expect(
      await run('echo hi > /tmp/real-sandbox-probe && cat /tmp/real-sandbox-probe', scratch, rules(scratch)),
    ).toContain('hi');
    expect(await run(`echo hi > ${home}/escaped; echo exit=$?`, scratch, rules(scratch))).toContain('not permitted');
    expect(existsSync(path.join(home, 'escaped'))).toBe(false);
    // A sibling job's scratch copy is not this run's folder.
    expect(await run(`echo hi > ${data}/scratch/job-2; echo exit=$?`, scratch, rules(scratch))).toContain(
      'not permitted',
    );
    expect(existsSync(path.join(data, 'scratch', 'job-2'))).toBe(false);
  }, 240_000);

  it('writes in the tool caches a commit hook or build needs, and in no folder on PATH', async () => {
    // The sandbox matches real paths, so the folder exists first, as it does once a tool has used it.
    mkdirSync(path.join(home, '.cache'), { recursive: true });
    const cache = `mkdir -p ${home}/.cache/pre-commit && echo ok > ${home}/.cache/pre-commit/probe && cat ${home}/.cache/pre-commit/probe`;
    expect(await run(cache, checkout, rules(checkout))).toContain('ok');
    mkdirSync(path.join(home, '.cargo', 'bin'), { recursive: true });
    expect(await run(`echo x > ${home}/.cargo/bin/planted; echo exit=$?`, checkout, rules(checkout))).toContain(
      'not permitted',
    );
    expect(existsSync(path.join(home, '.cargo', 'bin', 'planted'))).toBe(false);
  }, 240_000);

  it('denies ~/.ssh to every run (console-opens-pull-request 16)', async () => {
    expect(await run(`cat ${home}/.ssh/key`, checkout, rules(checkout))).toContain('Operation not permitted');
  }, 120_000);

  it('still runs git and node (Behavior 9)', async () => {
    expect(await run('git --version && node -v', checkout, rules(checkout))).toMatch(/git version .*\nv\d+/);
  }, 120_000);

  it('refuses a host off the allowlist, names it, and lets the command finish (Network Behavior 1)', async () => {
    const out = await run('curl -sS -m 10 https://example.com; echo finished', checkout, rules(checkout));
    expect(out).toContain('deny network-outbound example.com:443 (host is not on the allow list)');
    expect(out).toContain('finished');
  }, 120_000);

  it('passes a host on the allowlist through the filter and refuses the same request once it is off (Network Behavior 1)', async () => {
    const viaProxy = `curl -sS -m 10 --noproxy '' -x $HTTP_PROXY http://localhost:${port}/ping; echo exit=$?`;
    expect(await run(viaProxy, checkout, rules(checkout, ['localhost']))).toContain('exit=0');
    expect(await run(viaProxy, checkout, rules(checkout, ['example.org']))).toContain('host is not on the allow list');
  }, 240_000);

  it('cannot go around the filter by IP address, DNS, UDP or a client that ignores the proxy (Network Behavior 2)', async () => {
    const failed = /exit=[1-9]/;
    expect(
      await run("curl -sS -m 8 --noproxy '*' -k https://93.184.216.34; echo exit=$?", checkout, rules(checkout)),
    ).toMatch(failed);
    expect(
      await run("curl -sS -m 8 --noproxy '*' https://example.com; echo exit=$?", checkout, rules(checkout)),
    ).toContain('Could not resolve host');
    expect(await run("bash -c 'echo x > /dev/udp/93.184.216.34/9'; echo exit=$?", checkout, rules(checkout))).toMatch(
      failed,
    );
    // Node's `fetch` ignores the proxy settings, so even an allowed host fails.
    expect(
      await run(
        "node -e 'fetch(process.argv[1]).then(r=>console.log(r.status),e=>console.log(e.cause.code))' https://api.github.com",
        checkout,
        rules(checkout),
      ),
    ).toContain('ENOTFOUND');
  }, 240_000);

  it("commits in a Session's own worktree, and still cannot write the Repo's hooks or config", async () => {
    const repo = path.join(path.dirname(data), 'session-repo');
    const worktree = path.join(data, 'session-worktrees', 's1');
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
        cwd: repo,
        stdio: 'pipe',
      });
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'first');
    git('worktree', 'add', '-q', '--detach', worktree);
    const sandbox = runSandbox({
      workingDir: worktree,
      dataDir: data,
      home,
      networkDomains: BUILT_IN,
      gitFile: true,
      gitDirs: worktreeGitDirs(worktree),
    });
    const commit = await run(
      'git checkout -q -b fix && echo x > f && git add f && git -c user.name=T -c user.email=t@example.com commit -q -m c && git log --oneline | head -1; echo exit=$?',
      worktree,
      sandbox,
    );
    expect(commit).toContain('exit=0');
    expect(git('rev-parse', '--verify', 'fix').toString().trim()).toHaveLength(40);
    const closed = await run(
      `echo x > ${repo}/.git/config; echo a=$?; echo x > ${repo}/.git/hooks/pre-commit; echo b=$?`,
      worktree,
      sandbox,
    );
    expect(closed).toMatch(/not permitted/);
    expect(closed).not.toContain('a=0');
    expect(closed).not.toContain('b=0');
  }, 240_000);

  it('reports the sandbox on when Seatbelt works (Behavior 10)', async () => {
    expect(await new SeatbeltRunSandbox().check()).toEqual({ status: 'on', reason: null });
  });
});
