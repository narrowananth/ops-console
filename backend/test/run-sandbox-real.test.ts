import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSandbox, worktreeGitDirs } from '../src/agent/run-sandbox';
import { SeatbeltRunSandbox } from '../src/machine/run-sandbox-gate';

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
  mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true });
  writeFileSync(path.join(home, 'Library', 'Keychains', 'login.keychain-db'), 'keychain-ok');
  mkdirSync(path.join(home, '.ops-console'), { recursive: true });
  writeFileSync(path.join(home, '.ops-console', 'note'), 'app-ok');

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

const rules = (workingDir: string) => runSandbox({ workingDir, home });

describe.skipIf(process.platform !== 'darwin' || CLAUDE === null)('Run sandbox, enforced by Seatbelt', () => {
  it('reads the Keychain folder with no sandbox, so the cases below prove something', async () => {
    expect(await run(`cat ${home}/Library/Keychains/login.keychain-db`, scratch, null)).toContain('keychain-ok');
  }, 60_000);

  it('cannot read the login Keychain folder or the installed app', async () => {
    const keychain = await run(`cat ${home}/Library/Keychains/login.keychain-db`, scratch, rules(scratch));
    expect(keychain).toContain('Operation not permitted');
    expect(keychain).not.toContain('keychain-ok');
    const app = await run(`cat ${home}/.ops-console/note`, scratch, rules(scratch));
    expect(app).toContain('Operation not permitted');
    expect(app).not.toContain('app-ok');
  }, 120_000);

  it('reads and writes everything else: the data folder, the credential folders, the home folder', async () => {
    expect(await run(`cat ${data}/runtime.json`, scratch, rules(scratch))).toContain('SECRET');
    expect(await run(`cat ${home}/.ssh/key`, checkout, rules(checkout))).toContain('ssh-ok');
    expect(await run(`echo hi > ${home}/anywhere && cat ${home}/anywhere`, scratch, rules(scratch))).toContain('hi');
    expect(
      await run(`echo hi > ${data}/scratch/job-2 && cat ${data}/scratch/job-2`, scratch, rules(scratch)),
    ).toContain('hi');
    mkdirSync(path.join(home, '.cargo', 'bin'), { recursive: true });
    expect(await run(`echo x > ${home}/.cargo/bin/planted && echo exit=$?`, checkout, rules(checkout))).toContain(
      'exit=0',
    );
  }, 240_000);

  it('still runs git and node', async () => {
    expect(await run('git --version && node -v', checkout, rules(checkout))).toMatch(/git version .*\nv\d+/);
  }, 120_000);

  it('reaches any host through the filter, and a local port directly', async () => {
    const viaProxy = `curl -sS -m 10 --noproxy '' -x $HTTP_PROXY http://localhost:${port}/ping; echo exit=$?`;
    expect(await run(viaProxy, checkout, rules(checkout))).toContain('exit=0');
    const direct = `curl -sS -m 6 --noproxy '*' http://127.0.0.1:${port}/ping; echo exit=$?`;
    expect(await run(direct, checkout, rules(checkout))).toContain('exit=0');
  }, 240_000);

  it('binds and reaches local ports, listens on every address and uses a Unix socket', async () => {
    writeFileSync(
      path.join(checkout, 'bind.js'),
      "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log('bind=ok');s.close()});s.on('error',e=>console.log('bind='+e.code))",
    );
    writeFileSync(
      path.join(checkout, 'self.js'),
      "const n=require('net');const s=n.createServer(c=>c.end('hi')).listen(0,'127.0.0.1',()=>{n.connect(s.address().port,'127.0.0.1').on('data',()=>{console.log('self=ok');process.exit()}).on('error',e=>{console.log('self='+e.code);process.exit()})});s.on('error',e=>{console.log('self='+e.code);process.exit()})",
    );
    writeFileSync(
      path.join(checkout, 'all.js'),
      "const s=require('net').createServer().listen(0,'0.0.0.0',()=>{console.log('all=ok');s.close()});s.on('error',e=>console.log('all='+e.code))",
    );
    writeFileSync(
      path.join(checkout, 'unix.js'),
      "const s=require('net').createServer().listen('/tmp/loopback-'+process.pid+'.sock',()=>{console.log('unix=ok');s.close()});s.on('error',e=>console.log('unix='+e.code))",
    );
    expect(await run('node bind.js', checkout, rules(checkout))).toContain('bind=ok');
    expect(await run('node all.js', checkout, rules(checkout))).toContain('all=ok');
    expect(await run('node self.js', checkout, rules(checkout))).toContain('self=ok');
    expect(await run('node unix.js', checkout, rules(checkout))).toContain('unix=ok');
  }, 600_000);

  it('cannot change the working folder of a read-only run', async () => {
    const readOnly = runSandbox({ workingDir: checkout, home, readOnly: true });
    expect(await run(`echo x > ${checkout}/changed; echo exit=$?`, checkout, readOnly)).toContain('not permitted');
    expect(existsSync(path.join(checkout, 'changed'))).toBe(false);
    expect(await run('echo hi > /tmp/read-only-probe && cat /tmp/read-only-probe', checkout, readOnly)).toContain('hi');
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
      home,
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
