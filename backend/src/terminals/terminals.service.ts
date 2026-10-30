import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  ActionKind,
  ActionOutcome,
  type Connection,
  type CreateConnection,
  ErrorCode,
  type TerminalKind,
  type TerminalServerMessage,
} from '@ops-console/shared';
import type { IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import { AccountsService } from '../accounts/accounts.service';
import { ActionLogService } from '../action-log/action-log.service';
import { CLAUDE_CLI, type ClaudeCli, claudeEnv } from '../claude-cli/claude-cli';
import { DAEMON_ADDRESS, type DaemonAddress } from '../common/daemon-address';
import { DATA_DIR } from '../common/data-dir';
import { ApiError, validationFailed } from '../common/errors';
import { SESSION, type Session } from '../common/session';
import { ConnectionsService } from '../connections/connections.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { MCP_CONFIG, type McpConfig, McpServersService } from '../mcp/mcp-servers.service';
import { maskLine, PLACEHOLDER } from './secret-masking';
import { SETUP_AGENT, writeSetupFiles } from './setup-agent';

/** A terminal nobody connected to is ended after this. */
export const UNATTACHED_MS = 30_000;
const ENTER_DELAY_MS = 80;
const REPLAY_BYTES = 64 * 1024;

type SecretRequest = { label: string; resolve(placeholder: string): void; reject(error: Error): void };

type Terminal = {
  id: string;
  dir: string;
  pty: IPty;
  sockets: Set<WebSocket>;
  /** Pending secrets: placeholder `{{secret:<n>}}` is `secrets[n - 1]`. Daemon memory only. */
  secrets: string[];
  requests: Map<string, SecretRequest>;
  replay: string;
  attached: boolean;
  timer: NodeJS.Timeout;
};

@Injectable()
export class TerminalsService implements OnModuleDestroy {
  private readonly terminals = new Map<string, Terminal>();

  constructor(
    @Inject(DATA_DIR) private readonly dataDir: string,
    @Inject(SESSION) private readonly session: Session,
    @Inject(CLAUDE_CLI) private readonly claude: ClaudeCli,
    @Inject(MCP_CONFIG) private readonly mcpConfig: McpConfig,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(ActionLogService) private readonly actionLog: ActionLogService,
    @Inject(ConnectionsService) private readonly connections: ConnectionsService,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(McpServersService) private readonly mcp: McpServersService,
    @Inject(DAEMON_ADDRESS) private readonly address: DaemonAddress,
  ) {}

  onModuleDestroy(): void {
    for (const id of [...this.terminals.keys()]) void this.end(id);
  }

  /** Starts `claude --agent dev-tools-setup` in a pty under the active account's config dir. */
  async create(_kind: TerminalKind): Promise<{ id: string }> {
    const account = this.accounts.active();
    const id = crypto.randomUUID();
    const dir = path.join(this.dataDir, 'terminals', id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const { mcpConfig } = await writeSetupFiles(dir, {
      launcher: this.mcpConfig.launcher,
      url: this.address.url(),
      token: this.session.token,
      terminalId: id,
    });
    await trustFolder(this.accounts.configDir(account), await realpath(dir));
    const nodePty = await loadPty();
    // Markers of the Claude Code session the daemon may have been started from would turn off this one's transcript.
    const env = { ...claudeEnv(this.accounts.configDir(account)) };
    for (const marker of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT']) delete env[marker];
    const pty = nodePty.spawn(
      this.claude.bin,
      ['--agent', SETUP_AGENT, '--mcp-config', mcpConfig, '--strict-mcp-config'],
      {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd: dir,
        env: {
          ...claudeEnv(this.accounts.configDir(account)),
          OPS_CONSOLE_URL: this.address.url(),
          OPS_CONSOLE_TOKEN: this.session.token,
          OPS_CONSOLE_TERMINAL: id,
        } as Record<string, string>,
      },
    );
    const terminal: Terminal = {
      id,
      dir,
      pty,
      sockets: new Set(),
      secrets: [],
      requests: new Map(),
      replay: '',
      attached: false,
      timer: setTimeout(() => void this.end(id), UNATTACHED_MS),
    };
    this.terminals.set(id, terminal);
    pty.onData((data) => {
      terminal.replay = (terminal.replay + data).slice(-REPLAY_BYTES);
      this.send(terminal, { type: 'output', data });
    });
    pty.onExit(({ exitCode }) => {
      this.send(terminal, { type: 'exit', code: exitCode });
      void this.end(id);
    });
    return { id };
  }

  has(id: string): boolean {
    return this.terminals.has(id);
  }

  /** Connects a socket; what the terminal printed so far is replayed to it. */
  attach(id: string, socket: WebSocket): void {
    const terminal = this.get(id);
    clearTimeout(terminal.timer);
    terminal.attached = true;
    terminal.sockets.add(socket);
    if (terminal.replay) socket.send(JSON.stringify({ type: 'output', data: terminal.replay }));
    for (const [requestId, request] of terminal.requests) {
      socket.send(JSON.stringify({ type: 'secret_requested', request_id: requestId, label: request.label }));
    }
    // Closing the drawer or reloading the page ends the terminal (Behavior 17).
    socket.once('close', () => {
      terminal.sockets.delete(socket);
      if (terminal.sockets.size === 0) void this.end(id);
    });
  }

  input(id: string, data: string): void {
    this.get(id).pty.write(data);
  }

  /** A full line: secrets are swapped for placeholders before Claude sees it, and the echo shows the placeholders. */
  line(id: string, text: string): void {
    const terminal = this.get(id);
    const masked = maskLine(text, (value) => this.keep(terminal, value));
    // Claude Code's prompt reads text and Enter arriving together as one paste, so Enter follows on its own.
    terminal.pty.write(masked);
    setTimeout(() => this.terminals.get(id)?.pty.write('\r'), ENTER_DELAY_MS);
  }

  resize(id: string, cols: number, rows: number): void {
    this.get(id).pty.resize(cols, rows);
  }

  /** The operator filled the masked field the setup agent asked for. */
  answerSecret(id: string, requestId: string, value: string): void {
    const terminal = this.get(id);
    const request = terminal.requests.get(requestId);
    if (!request) throw new ApiError(404, ErrorCode.NotFound, 'no such secret request');
    terminal.requests.delete(requestId);
    request.resolve(`{{secret:${this.keep(terminal, value)}}}`);
  }

  /** Runs a setup tool. The REST endpoints run the same code. */
  async runTool(id: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const terminal = this.get(id);
    switch (tool) {
      case 'request_secret':
        return { placeholder: await this.requestSecret(terminal, String(args.label ?? 'a secret')) };
      case 'test_connection':
        return this.testConnection(terminal, args);
      case 'save_connection': {
        const body = { ...args, secret: this.resolve(terminal, args.secret) } as CreateConnection;
        const saved: Connection = await this.connections.create(body);
        this.send(terminal, { type: 'saved', target: 'connection', id: saved.id });
        return saved;
      }
      case 'connect_connector': {
        const connectorId = String(args.id);
        await this.connectors.connect(connectorId as never, this.resolve(terminal, args.secret) ?? undefined);
        this.send(terminal, { type: 'saved', target: 'connector', id: connectorId });
        return { started: connectorId };
      }
      case 'authenticate_mcp_server': {
        await this.mcp.authenticate(String(args.name));
        this.send(terminal, { type: 'saved', target: 'mcp_server', id: String(args.name) });
        return { started: String(args.name) };
      }
      default:
        throw validationFailed(`invalid params: tool ${tool}`);
    }
  }

  async end(id: string): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    this.terminals.delete(id);
    clearTimeout(terminal.timer);
    for (const request of terminal.requests.values()) request.reject(new Error('the terminal ended'));
    terminal.secrets.length = 0;
    try {
      terminal.pty.kill();
    } catch {
      // Already gone.
    }
    for (const socket of terminal.sockets) socket.close();
    await rm(terminal.dir, { recursive: true, force: true });
  }

  /** Each test writes an Action Log row of kind `query` first (Behavior 16). */
  private async testConnection(terminal: Terminal, args: Record<string, unknown>) {
    const config = (args.config ?? {}) as Record<string, unknown>;
    const where = `${String(config.host ?? '')}${config.port ? `:${String(config.port)}` : ''}/${String(config.database ?? '')}`;
    const logId = this.actionLog.start({
      sessionId: null,
      kind: ActionKind.Query,
      target: `${String(args.type)} ${where}`,
      command: `test_connection ${String(args.type)} ${where}`,
      isProd: false,
    });
    try {
      const result = await this.connections.test(args.type as never, config, this.resolve(terminal, args.secret));
      this.actionLog.finish(logId, result.status === 'ok' ? ActionOutcome.Ok : ActionOutcome.Failed, result.detail);
      return result;
    } catch (error) {
      this.actionLog.finish(logId, ActionOutcome.Failed, error instanceof ApiError ? error.message : 'the test failed');
      throw error;
    }
  }

  private requestSecret(terminal: Terminal, label: string): Promise<string> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      terminal.requests.set(requestId, { label, resolve, reject });
      this.send(terminal, { type: 'secret_requested', request_id: requestId, label });
    });
  }

  /** Swaps `{{secret:<n>}}` for the pending secret. Only the daemon ever holds the value. */
  private resolve(terminal: Terminal, value: unknown): string | null {
    if (value === undefined || value === null) return null;
    return String(value).replace(PLACEHOLDER, (_all, n: string) => {
      const secret = terminal.secrets[Number(n) - 1];
      if (secret === undefined) throw validationFailed(`invalid body: unknown placeholder {{secret:${n}}}`);
      return secret;
    });
  }

  private keep(terminal: Terminal, value: string): number {
    const known = terminal.secrets.indexOf(value);
    if (known !== -1) return known + 1;
    terminal.secrets.push(value);
    return terminal.secrets.length;
  }

  private send(terminal: Terminal, message: TerminalServerMessage): void {
    const text = JSON.stringify(message);
    for (const socket of terminal.sockets) if (socket.readyState === socket.OPEN) socket.send(text);
  }

  private get(id: string): Terminal {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new ApiError(404, ErrorCode.NotFound, 'no such terminal');
    return terminal;
  }
}

type NodePty = typeof import('node-pty');
let loaded: NodePty | undefined;

/** node-pty ships its macOS helper without the execute bit; spawning fails until it has it. */
async function loadPty(): Promise<NodePty> {
  if (loaded) return loaded;
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    await chmod(path.join(root, 'prebuilds', arch, 'spawn-helper'), 0o755).catch(() => {});
  }
  loaded = require('node-pty') as NodePty;
  return loaded;
}

/**
 * Claude Code asks about its theme, the security notes and whether to trust the folder before it starts, and the
 * folder prompt defaults to "No, exit". The console made this folder, so it marks it trusted in the account's config.
 */
async function trustFolder(configDir: string, folder: string): Promise<void> {
  const file = path.join(configDir, '.claude.json');
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // A new account has no config yet.
  }
  const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>;
  projects[folder] = { ...projects[folder], hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true };
  const next = { ...config, hasCompletedOnboarding: true, theme: config.theme ?? 'dark', projects };
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await rename(temp, file);
}
