import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { redact } from '../action-log/redact';

const exec = promisify(execFile);

/** The integration CLIs a run may ask the console to run outside the Run sandbox (ADR 0006). */
export const INTEGRATION_CLIS = ['pup', 'gh', 'glab', 'bkt', 'slashdocs'] as const;
export type IntegrationCliName = (typeof INTEGRATION_CLIS)[number];

export const integrationInputSchema = z.object({
  cli: z.enum(INTEGRATION_CLIS),
  /** The command words first (`pr view 12`), then the flags (`--repo owner/name`). One argument per entry, no shell. */
  args: z.array(z.string().max(20_000)).min(1).max(40),
});
export type IntegrationInput = z.infer<typeof integrationInputSchema>;

export type CliVerdict = { kind: 'read' } | { kind: 'write' } | { kind: 'deny'; reason: string };

const deny = (reason: string): CliVerdict => ({ kind: 'deny', reason });

/** A merge, by any spelling: no CLI call to the console's tool may merge (ADR 0002). */
const MERGE = [
  /pulls\/[^\s]*\/merge/i,
  /merge_requests\/[^\s]*\/merge/i,
  /pullrequests\/[^\s]*\/merge/i,
  /mergePullRequest/i,
  /enablePullRequestAutoMerge/i,
  /auto-?merge/i,
];

/** Flags that take a secret or point the CLI at another server with the operator's sign-in. */
const FORBIDDEN_FLAGS = /^--(token|config|server|hostname|host|env|exec|edit|web)(=|$)/i;

/** The leading words of a command, up to the first flag. */
function words(args: string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('-')) break;
    out.push(arg);
  }
  return out;
}

const starts = (command: string[], rule: string[]) => rule.every((word, index) => command[index] === word);
const any = (command: string[], rules: string[][]) => rules.some((rule) => starts(command, rule));

/** A raw API call is a read only with no method but GET and no body. */
function apiVerdict(args: string[]): CliVerdict {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    const method = /^(?:-X|--method)(?:=(.*))?$/.exec(arg) ?? /^-X(.+)$/.exec(arg);
    if (method) {
      const value = (method[1] ?? args[i + 1] ?? '').toUpperCase();
      if (value !== 'GET') return { kind: 'write' };
    }
    if (/^(-f|-F|-d|--field|--raw-field|--input|--data|--data-raw|--body)(=|$)/.test(arg)) return { kind: 'write' };
  }
  return { kind: 'read' };
}

const GIT_HOST_RULES = {
  gh: {
    read: [
      ['pr', 'view'],
      ['pr', 'list'],
      ['pr', 'diff'],
      ['pr', 'checks'],
      ['pr', 'status'],
      ['issue', 'view'],
      ['issue', 'list'],
      ['issue', 'status'],
      ['repo', 'view'],
      ['repo', 'list'],
      ['run', 'view'],
      ['run', 'list'],
      ['workflow', 'view'],
      ['workflow', 'list'],
      ['release', 'view'],
      ['release', 'list'],
      ['search'],
      ['status'],
    ],
    write: [
      ['pr', 'create'],
      ['pr', 'edit'],
      ['pr', 'comment'],
      ['pr', 'review'],
      ['pr', 'ready'],
      ['pr', 'close'],
      ['pr', 'reopen'],
      ['issue', 'create'],
      ['issue', 'edit'],
      ['issue', 'comment'],
      ['issue', 'close'],
      ['issue', 'reopen'],
      ['run', 'rerun'],
      ['run', 'cancel'],
    ],
  },
  glab: {
    read: [
      ['mr', 'view'],
      ['mr', 'list'],
      ['mr', 'diff'],
      ['issue', 'view'],
      ['issue', 'list'],
      ['repo', 'view'],
      ['ci', 'status'],
      ['ci', 'list'],
      ['ci', 'view'],
      ['ci', 'trace'],
    ],
    write: [
      ['mr', 'create'],
      ['mr', 'update'],
      ['mr', 'note'],
      ['mr', 'close'],
      ['mr', 'reopen'],
      ['issue', 'create'],
      ['issue', 'update'],
      ['issue', 'note'],
      ['issue', 'close'],
      ['issue', 'reopen'],
    ],
  },
  bkt: {
    read: [
      ['pr', 'list'],
      ['pr', 'view'],
      ['pr', 'diff'],
      ['pr', 'checks'],
      ['pr', 'comments'],
      ['repo', 'list'],
      ['repo', 'view'],
      ['branch', 'list'],
      ['commit', 'list'],
      ['commit', 'view'],
      ['issue', 'list'],
      ['issue', 'view'],
      ['pipeline', 'list'],
      ['pipeline', 'view'],
      ['status'],
    ],
    write: [
      ['pr', 'create'],
      ['pr', 'edit'],
      ['pr', 'comment'],
      ['pr', 'approve'],
      ['issue', 'create'],
      ['issue', 'comment'],
    ],
  },
} as const;

const READ_VERBS = new Set([
  'list',
  'get',
  'search',
  'query',
  'aggregate',
  'show',
  'describe',
  'status',
  'history',
  'find',
  'count',
  'top',
  'versions',
  'comments',
  'read',
  'view',
]);
const WRITE_VERBS = new Set([
  'create',
  'update',
  'delete',
  'remove',
  'mute',
  'unmute',
  'cancel',
  'resolve',
  'trigger',
  'run',
  'post',
  'send',
  'add',
  'set',
  'patch',
  'edit',
  'import',
  'upload',
  'archive',
  'restore',
  'enable',
  'disable',
  'start',
  'stop',
  'apply',
  'execute',
  'submit',
  'publish',
  'share',
  'comment',
  'reply',
]);

/** Groups that sign in or out, hold keys, install code or serve a proxy: never through the console's tool. */
const PUP_DENIED = new Set(['acp', 'alias', 'auth', 'api-keys', 'app-keys', 'completions', 'extension', 'mcp']);
const SLASHDOCS_DENIED = new Set([
  'auth',
  'completion',
  'context',
  'local',
  'notifications',
  'open',
  'sa',
  'skills',
  'update',
]);

/** A verb-by-verb rule for a CLI with too many commands to list: a read verb reads, anything else asks. */
function byVerb(command: string[]): CliVerdict {
  const verbs = command.slice(1, 3);
  if (verbs.some((verb) => WRITE_VERBS.has(verb))) return { kind: 'write' };
  return command[1] !== undefined && READ_VERBS.has(command[1]) ? { kind: 'read' } : { kind: 'write' };
}

/**
 * What a command is, by its words: a read runs at once, a write waits for the operator's Approval, and the rest is
 * refused. Default deny: sign-in, tokens, extensions, aliases, config and merges are never on the lists.
 */
export function classifyCli(cli: IntegrationCliName, args: string[]): CliVerdict {
  const first = args[0] ?? '';
  if (first.startsWith('-')) return deny('Put the command words first, then the flags.');
  if (args.some((arg) => arg.includes('\0'))) return deny('An argument holds a NUL byte.');
  const flag = args.find((arg) => FORBIDDEN_FLAGS.test(arg));
  if (flag) return deny(`${flag.split('=')[0]} is not allowed: it passes a secret or another server to the CLI.`);
  if (args.some((arg) => MERGE.some((pattern) => pattern.test(arg))))
    return deny('A merge is the operator’s to press.');
  const command = words(args);
  if (command[0] === 'api') return apiVerdict(args);
  if (cli === 'pup') {
    if (PUP_DENIED.has(command[0] ?? '')) return deny(`pup ${command[0]} is not available here.`);
    return byVerb(command);
  }
  if (cli === 'slashdocs') {
    if (SLASHDOCS_DENIED.has(command[0] ?? '')) return deny(`slashdocs ${command[0]} is not available here.`);
    if (command[0] === 'guidelines' || command[0] === 'version' || command[0] === 'config') return { kind: 'read' };
    return byVerb(command);
  }
  const rules = GIT_HOST_RULES[cli];
  if (any(command, rules.read as unknown as string[][])) return { kind: 'read' };
  if (any(command, rules.write as unknown as string[][])) return { kind: 'write' };
  return deny(`${cli} ${command.slice(0, 2).join(' ')} is not on the list the console runs.`);
}

/** True when `target` is `root` or inside it, after resolving links. */
function inside(root: string, target: string): boolean {
  const resolve = (file: string) => {
    try {
      return realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  const relative = path.relative(resolve(root), resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * An argument that names a file the CLI would read or upload, outside the folders the run itself may reach: the CLI
 * runs outside the sandbox, so it must not become a way to read what the sandbox hides. A path that does not exist is
 * an API path or a flag value, not a file.
 */
export function outsideFile(args: string[], roots: string[], cwd: string, home = os.homedir()): string | null {
  for (const arg of args) {
    const value = arg.includes('=') && arg.startsWith('-') ? arg.slice(arg.indexOf('=') + 1) : arg;
    if (value === '' || value.includes('\0') || value.length > 4096) continue;
    const file = value.startsWith('~') ? path.join(home, value.slice(1)) : path.resolve(cwd, value);
    if (!existsSync(file)) continue;
    if (!roots.some((root) => inside(root, file))) return value;
  }
  return null;
}

/** What the agent's `run_integration` tool calls. */
export interface IntegrationRunner {
  /** Runs a classified command outside the sandbox. Output is redacted and cut to a size the agent can read. */
  run(input: IntegrationInput): Promise<{ text: string; ok: boolean }>;
}

const OUTPUT_CHARS = 100_000;
const TIMEOUT_MS = 60_000;

/** The environment a CLI gets: where to find itself and its own sign-in, and nothing of the daemon's. */
export function cliEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const pick = (name: string) => (source[name] ? { [name]: source[name] as string } : {});
  const bins = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const base = (source.PATH ?? '').split(':').filter(Boolean);
  return {
    ...pick('HOME'),
    ...pick('USER'),
    ...pick('LOGNAME'),
    ...pick('LANG'),
    ...pick('TMPDIR'),
    PATH: [...new Set([...base, ...bins])].join(':'),
    NO_COLOR: '1',
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** Runs `cli` with `args` in `cwd`, no shell, no stdin, under a time and size cap. Never throws on a failed command. */
export async function runCli(
  cli: IntegrationCliName,
  args: string[],
  cwd: string,
): Promise<{ text: string; ok: boolean }> {
  try {
    const pending = exec(cli, args, { cwd, env: cliEnv(), timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    pending.child.stdin?.end();
    const { stdout, stderr } = await pending;
    return { text: cap(`${stdout}${stderr ? `\n${stderr}` : ''}`), ok: true };
  } catch (error) {
    const { stdout, stderr, killed, code } = error as {
      stdout?: unknown;
      stderr?: unknown;
      killed?: boolean;
      code?: unknown;
    };
    const out = `${typeof stdout === 'string' ? stdout : ''}${typeof stderr === 'string' && stderr ? `\n${stderr}` : ''}`;
    const why = killed
      ? `${cli} ran past ${TIMEOUT_MS / 1000} seconds and was stopped.`
      : code === 'ENOENT'
        ? `${cli} is not installed.`
        : '';
    return { text: cap(`${why}\n${out}`.trim() || `${cli} failed.`), ok: false };
  }
}

function cap(text: string): string {
  const safe = redact(text);
  return safe.length > OUTPUT_CHARS ? `${safe.slice(0, OUTPUT_CHARS)}\n… cut at ${OUTPUT_CHARS} characters.` : safe;
}
