import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ErrorCode } from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';

const run = promisify(execFile);

export const CLAUDE_CLI = Symbol('CLAUDE_CLI');

export type McpScope = 'local' | 'project' | 'user';
const statusSchema = z.enum(['connected', 'failed', 'needs_auth', 'pending', 'unknown']);
export type McpStatus = z.infer<typeof statusSchema>;

const listedServerSchema = z.object({ name: z.string(), target: z.string(), status: statusSchema });
export type ListedMcpServer = z.infer<typeof listedServerSchema>;

const serverConfigSchema = z.discriminatedUnion('transport', [
  z.object({
    name: z.string(),
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
  }),
  z.object({
    name: z.string(),
    transport: z.enum(['http', 'sse']),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
  }),
]);
export type McpServerConfig = z.infer<typeof serverConfigSchema>;

export type McpServerToAdd = McpServerConfig & { scope: McpScope };

/** `claude mcp get` joins args with spaces, so an arg holding a space comes back split. */
export class ClaudeCli {
  constructor(private readonly bin = 'claude') {}

  async mcpList(): Promise<ListedMcpServer[]> {
    const output = await this.exec(['mcp', 'list'], 'list');
    const servers: ListedMcpServer[] = [];
    for (const line of output.split('\n')) {
      const match = /^([A-Za-z0-9_.-]+): (.+) - (.+)$/.exec(line.trim());
      if (match)
        servers.push(listedServerSchema.parse({ name: match[1], target: match[2], status: statusOf(match[3] ?? '') }));
    }
    return servers;
  }

  async mcpGet(name: string): Promise<McpServerConfig> {
    const output = await this.exec(['mcp', 'get', name], 'get');
    const fields = new Map<string, string>();
    const block: Record<string, string> = {};
    let inBlock = false;
    for (const line of output.split('\n')) {
      const nested = /^ {4,}(\S.*)$/.exec(line);
      const field = /^ {2}([A-Za-z]+): ?(.*)$/.exec(line);
      if (nested && inBlock) {
        const pair = /^([^=:]+)(?:=|: )(.*)$/.exec(nested[1] ?? '');
        if (pair) block[(pair[1] ?? '').trim()] = pair[2] ?? '';
      } else if (field) {
        fields.set(field[1] ?? '', field[2] ?? '');
        inBlock = field[1] === 'Environment' || field[1] === 'Headers';
      }
    }
    const type = fields.get('Type');
    return serverConfigSchema.parse(
      type === 'stdio'
        ? { name, transport: 'stdio', command: fields.get('Command'), args: splitArgs(fields.get('Args')), env: block }
        : { name, transport: type, url: fields.get('URL'), headers: block },
    );
  }

  async mcpAdd(server: McpServerToAdd): Promise<void> {
    const args =
      server.transport === 'stdio'
        ? [
            ...Object.entries(server.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
            server.name,
            '--',
            server.command,
            ...server.args,
          ]
        : [
            '--transport',
            server.transport,
            ...Object.entries(server.headers).flatMap(([key, value]) => ['--header', `${key}: ${value}`]),
            server.name,
            server.url,
          ];
    await this.exec(['mcp', 'add', '--scope', server.scope, ...args], 'add');
  }

  async mcpRemove(name: string, scope: McpScope): Promise<void> {
    await this.exec(['mcp', 'remove', name, '--scope', scope], 'remove');
  }

  /** Errors name the subcommand only: arguments and output may hold secrets. */
  private async exec(args: string[], subcommand: string): Promise<string> {
    try {
      const { stdout } = await run(this.bin, args, { maxBuffer: 10 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      throw new ApiError(502, ErrorCode.UpstreamFailed, `\`claude mcp ${subcommand}\` failed (${String(code)})`);
    }
  }
}

function statusOf(text: string): McpStatus {
  if (/connected/i.test(text) && !/failed/i.test(text)) return 'connected';
  if (/failed/i.test(text)) return 'failed';
  if (/auth/i.test(text)) return 'needs_auth';
  if (/pending/i.test(text)) return 'pending';
  return 'unknown';
}

function splitArgs(text: string | undefined): string[] {
  return text?.trim() ? text.trim().split(/\s+/) : [];
}
