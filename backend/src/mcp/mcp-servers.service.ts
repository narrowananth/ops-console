import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  CheckTarget,
  type CreateMcpServer,
  ErrorCode,
  HealthStatus,
  McpAuth,
  McpScope,
  type McpServer,
  McpTransport,
  type UpdateMcpServer,
} from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { AccountsService } from '../accounts/accounts.service';
import { CLAUDE_CLI, type ClaudeCli, type McpServerToAdd, type McpTarget } from '../claude-cli/claude-cli';
import { DATA_DIR } from '../common/data-dir';
import { ApiError } from '../common/errors';
import { disabledMcpServers, removedMcpServers } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { KEYCHAIN, type Keychain } from '../keychain/keychain';
import { configFile, type RegisteredScope, type RegisteredServer, readRegistered } from './claude-config';
import { launcherArgv, parseEnv, secretsKey, unwrapLauncher } from './launcher';
import { PROBE, type Probe, type ProbedServer } from './probe';

export const MCP_CONFIG = Symbol('MCP_CONFIG');

export type McpConfig = {
  probe: Probe;
  /** The `ops-console` command a stdio server with env vars is registered through. */
  launcher: string;
};

/** A Probe result is reused this long. Reconnect and every registration change ask again. */
export const PROBE_TTL_MS = 60_000;

type Account = ReturnType<AccountsService['all']>[number];
/** `servers` is `null` when Claude Code did not answer. */
type Probed = { servers: Map<string, ProbedServer> | null; at: number };

/** Words back into one line, quoting those `splitCommand` would split. */
export function joinCommand(words: string[]): string {
  return words.map((word) => (/[\s"']/.test(word) ? `"${word}"` : word)).join(' ');
}

/** `a "b c" d` into words. */
export function splitCommand(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

@Injectable()
export class McpServersService implements OnModuleDestroy {
  private readonly logger = new Logger('mcp');
  private readonly probes = new Map<string, Probed>();
  private readonly logins = new Set<AbortController>();

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(CLAUDE_CLI) private readonly claude: ClaudeCli,
    @Inject(KEYCHAIN) private readonly keychain: Keychain,
    @Inject(PROBE) private readonly probe: Probe,
    @Inject(MCP_CONFIG) private readonly config: McpConfig,
    @Inject(DATA_DIR) private readonly dataDir: string,
  ) {}

  onModuleDestroy(): void {
    for (const login of this.logins) login.abort();
  }

  async list(): Promise<{ data: McpServer[]; meta: { next_cursor: null; connection_server_count: number } }> {
    return { data: await this.servers(), meta: { next_cursor: null, connection_server_count: 0 } };
  }

  async get(name: string): Promise<McpServer> {
    return this.require(await this.servers(), name);
  }

  async create(body: CreateMcpServer): Promise<McpServer> {
    refuseProjectScope(body.scope);
    const existing = await this.servers();
    if (existing.some((server) => server.name === body.name) || this.connectionNames().has(body.name)) {
      throw new ApiError(409, ErrorCode.Duplicate, `${body.name} is already used`);
    }
    await this.register(body.name, body.scope, body.transport, body.target, body.env ?? {}, body.headers ?? {}, null);
    return this.checked(body.name);
  }

  async update(name: string, body: UpdateMcpServer): Promise<McpServer> {
    const current = this.require(await this.servers(), name);
    if (body.enabled !== undefined) this.setEnabled(name, body.enabled);
    const changesConfig = [body.transport, body.target, body.scope, body.env, body.headers].some(
      (v) => v !== undefined,
    );
    if (!changesConfig) return this.get(name);

    const transport = body.transport ?? current.transport;
    if (body.transport !== undefined && body.transport !== current.transport && body.target === undefined) {
      throw new ApiError(400, ErrorCode.ValidationFailed, 'a new transport needs a new command or URL');
    }
    const scope = body.scope ?? current.scope;
    refuseProjectScope(scope);
    const previous = await this.registrations(name);
    const first = previous[0]?.entry;
    const target = body.target ?? current.target;
    const env = transport === McpTransport.Stdio ? await this.mergedEnv(name, body.env ?? {}) : {};
    const headers = { ...(first?.headers ?? {}), ...nonBlank(body.headers ?? {}) };
    await this.register(name, scope, transport, target, env, transport === McpTransport.Stdio ? {} : headers, previous);
    return this.checked(name);
  }

  /** Reconnect: registers the server where it is missing, then asks every account again. */
  async reconnect(name: string): Promise<McpServer> {
    const current = this.require(await this.servers(), name);
    if (!current.registered)
      throw new ApiError(409, ErrorCode.InvalidState, `${name} is removed; authenticate to add it again`);
    const views = await this.views(false);
    const have = views.find((view) => view.entries.has(name))?.entries.get(name);
    if (have) {
      for (const view of views) {
        if (view.entries.has(name)) continue;
        await this.claude.mcpAdd(toAdd(have), await this.target(view.account));
      }
    }
    return this.checked(name);
  }

  /** Starts the browser sign-in in each account whose Probe reads `auth`. `connection.checked` reports the result. */
  async authenticate(name: string): Promise<void> {
    const servers = await this.servers();
    const current = this.require(servers, name);
    if (!current.registered) {
      if (current.transport === McpTransport.Stdio) {
        throw new ApiError(409, ErrorCode.InvalidState, `${name} has no sign-in; add it again with its env vars`);
      }
      refuseProjectScope(current.scope);
      await this.register(name, current.scope, current.transport, current.target, {}, {}, null);
    }
    const views = await this.views(true);
    const waiting = views.filter((view) => view.state(name)?.status === HealthStatus.Auth);
    const abort = new AbortController();
    this.logins.add(abort);
    void (async () => {
      try {
        for (const view of waiting) {
          try {
            await this.claude.mcpLogin(name, view.account.configDir, abort.signal);
          } catch {
            this.logger.warn(`sign-in to ${name} did not finish in account ${view.account.label}`);
          }
        }
        await this.checked(name);
      } catch (error) {
        this.logger.error(`checking ${name} after sign-in failed: ${String(error)}`);
      } finally {
        this.logins.delete(abort);
      }
    })();
  }

  /** Remove: signs out and unregisters the server in every account, and keeps it listed. */
  async remove(name: string): Promise<McpServer> {
    const current = this.require(await this.servers(), name);
    if (!current.registered) return current;
    for (const { account } of await this.registrations(name)) {
      try {
        await this.claude.mcpLogout(name, account.configDir);
      } catch {
        // Servers without a sign-in have nothing to clear.
      }
      await this.claude.mcpRemove(name, current.scope, await this.target(account));
    }
    this.probes.clear();
    await this.keychain.delete(secretsKey(name));
    this.store.write((tx) => {
      tx.insert(removedMcpServers)
        .values({ name, scope: current.scope, transport: current.transport, target: current.target })
        .onConflictDoNothing()
        .run();
    });
    return this.get(name);
  }

  /** Adds (or, when `previous` is given, replaces) the server in every account; a failure undoes the accounts done. */
  private async register(
    name: string,
    scope: RegisteredScope,
    transport: McpTransport,
    target: string,
    env: Record<string, string>,
    headers: Record<string, string>,
    previous: { account: Account; entry: RegisteredServer }[] | null,
  ): Promise<void> {
    if (transport === McpTransport.Stdio && Object.keys(headers).length > 0) {
      throw new ApiError(400, ErrorCode.ValidationFailed, 'headers are for http and sse servers');
    }
    if (transport !== McpTransport.Stdio && Object.keys(env).length > 0) {
      throw new ApiError(400, ErrorCode.ValidationFailed, 'env vars are for stdio servers');
    }
    const spec = await this.specOf(name, scope, transport, target, env, headers);
    const touched: Account[] = [];
    try {
      if (Object.keys(env).length > 0) await this.keychain.set(secretsKey(name), JSON.stringify(env));
      else await this.keychain.delete(secretsKey(name));
      for (const account of this.accounts.all()) {
        const where = await this.target(account);
        const old = previous?.find((item) => item.account.id === account.id);
        if (old) await this.claude.mcpRemove(name, old.entry.scope, where);
        await this.claude.mcpAdd(spec, where);
        touched.push(account);
      }
    } catch (error) {
      // A new server leaves no trace (Behavior 5); an edit that fails part way is for the operator to retry.
      if (previous === null) {
        for (const account of touched) {
          await this.claude.mcpRemove(name, spec.scope, await this.target(account)).catch(() => {});
        }
        await this.keychain.delete(secretsKey(name));
      }
      throw error;
    } finally {
      this.probes.clear();
    }
  }

  private async specOf(
    name: string,
    scope: RegisteredScope,
    transport: McpTransport,
    target: string,
    env: Record<string, string>,
    headers: Record<string, string>,
  ): Promise<McpServerToAdd> {
    if (transport === McpTransport.Stdio) {
      const [command, ...args] = splitCommand(target);
      if (!command) throw new ApiError(400, ErrorCode.ValidationFailed, 'a stdio server needs a command');
      if (Object.keys(env).length === 0) return { name, scope, transport: 'stdio', command, args };
      const [launcher, launcherArgs] = launcherArgv(this.config.launcher, name, command, args);
      return { name, scope, transport: 'stdio', command: launcher, args: launcherArgs };
    }
    try {
      new URL(target);
    } catch {
      throw new ApiError(400, ErrorCode.ValidationFailed, 'an http or sse server needs a URL');
    }
    return { name, scope, transport, url: target, headers };
  }

  private async mergedEnv(name: string, changes: Record<string, string>): Promise<Record<string, string>> {
    return { ...(await this.storedEnv(name)), ...nonBlank(changes) };
  }

  private async storedEnv(name: string): Promise<Record<string, string>> {
    const stored = await this.keychain.get(secretsKey(name));
    if (stored === null) return {};
    return parseEnv(stored);
  }

  private setEnabled(name: string, enabled: boolean): void {
    this.store.write((tx) => {
      if (enabled) tx.delete(disabledMcpServers).where(eq(disabledMcpServers.name, name)).run();
      else tx.insert(disabledMcpServers).values({ name }).onConflictDoNothing().run();
    });
  }

  private dropRemoved(name: string): void {
    this.store.write((tx) => {
      tx.delete(removedMcpServers).where(eq(removedMcpServers.name, name)).run();
    });
  }

  /** Names a Connection's MCP server uses; Connections arrive with Settings › Dev tools. */
  private connectionNames(): Set<string> {
    return new Set();
  }

  private async localDir(): Promise<string> {
    const dir = path.join(this.dataDir, 'mcp-local');
    await mkdir(dir, { recursive: true });
    return realpath(dir);
  }

  private async target(account: Account): Promise<McpTarget> {
    return { configDir: account.configDir, cwd: await this.localDir() };
  }

  private async registrations(name: string): Promise<{ account: Account; entry: RegisteredServer }[]> {
    const views = await this.views(false);
    return views.flatMap((view) => {
      const entry = view.entries.get(name);
      return entry ? [{ account: view.account, entry }] : [];
    });
  }

  /** Every account with what its config registers and what the Probe reports. */
  private async views(force: boolean) {
    const local = await this.localDir();
    return Promise.all(
      this.accounts.all().map(async (account) => {
        const entries = new Map((await readRegistered(account.configDir, local)).map((entry) => [entry.name, entry]));
        let probed = account.signedIn ? await this.probeOf(account, local, force) : null;
        // A server added outside the console after the Probe was kept is not in it: ask again (Behavior 14).
        if (!force && probed?.servers && [...entries.keys()].some((name) => !probed?.servers?.has(name))) {
          probed = await this.probeOf(account, local, true);
        }
        return {
          account,
          entries,
          probed,
          /** This account's reading of one server; `null` when the account does not register it or is signed out. */
          state(name: string): { status: HealthStatus; detail: string | null; tools: string[] } | null {
            if (!entries.has(name) || probed === null) return null;
            if (probed.servers === null) {
              return { status: HealthStatus.Fail, detail: `${account.label}: Claude did not answer`, tools: [] };
            }
            const server = probed.servers.get(name);
            if (!server || server.status === 'disabled') {
              return { status: HealthStatus.Fail, detail: `${account.label}: Claude Code did not load it`, tools: [] };
            }
            if (server.status === 'connected') return { status: HealthStatus.Ok, detail: null, tools: server.tools };
            if (server.status === 'needs-auth') {
              return { status: HealthStatus.Auth, detail: `${account.label}: needs authentication`, tools: [] };
            }
            return {
              status: HealthStatus.Fail,
              detail: `${account.label}: ${server.error ?? 'did not finish starting'}`,
              tools: [],
            };
          },
        };
      }),
    );
  }

  private async probeOf(account: Account, local: string, force: boolean): Promise<Probed> {
    const kept = this.probes.get(account.configDir);
    if (!force && kept && Date.now() - kept.at < PROBE_TTL_MS) return kept;
    let result: Probed;
    try {
      const servers = await this.probe.run(account.configDir, local);
      result = { servers: new Map(servers.map((server) => [server.name, server])), at: Date.now() };
    } catch {
      result = { servers: null, at: Date.now() };
    }
    this.probes.set(account.configDir, result);
    return result;
  }

  private async servers(force = false): Promise<McpServer[]> {
    const views = await this.views(force);
    const disabled = new Set(
      this.store.db
        .select()
        .from(disabledMcpServers)
        .all()
        .map((row) => row.name),
    );
    const removed = this.store.db.select().from(removedMcpServers).all();
    const names = [...new Set(views.flatMap((view) => [...view.entries.keys()]))];
    const out: McpServer[] = [];

    for (const name of names) {
      const owner = views.find((view) => view.entries.has(name));
      const entry = owner?.entries.get(name);
      if (!owner || !entry) continue;
      const unwrapped = unwrapLauncher(this.config.launcher, entry.command, entry.args);
      const own = unwrapped ?? entry;
      const target =
        entry.transport === McpTransport.Stdio ? joinCommand([own.command, ...own.args]) : (entry.url ?? '');
      const envKeys = unwrapped ? Object.keys(await this.storedEnv(name)).sort() : [];
      const states = views.flatMap((view) => {
        const state = view.state(name);
        return state ? [state] : [];
      });
      const worst =
        states.find((s) => s.status === HealthStatus.Fail) ?? states.find((s) => s.status === HealthStatus.Auth);
      const reading = worst ??
        states[0] ?? { status: HealthStatus.Fail, detail: 'no signed-in Claude account', tools: [] as string[] };
      const enabled = !disabled.has(name);
      const secrets = [...Object.values(entry.headers), ...Object.values(unwrapped ? await this.storedEnv(name) : {})];
      out.push({
        name,
        scope: entry.scope,
        repo_id: null,
        transport: entry.transport,
        target: scrub(target, secrets),
        config_file: configFile(owner.account.configDir),
        auth:
          Object.keys(entry.headers).length > 0
            ? McpAuth.Headers
            : entry.transport === McpTransport.Stdio
              ? McpAuth.None
              : McpAuth.Oauth,
        status: enabled ? reading.status : HealthStatus.Off,
        status_detail: enabled && reading.detail !== null ? scrub(reading.detail, secrets) : null,
        tools: enabled && reading.status === HealthStatus.Ok ? reading.tools : [],
        tool_count: enabled && reading.status === HealthStatus.Ok ? reading.tools.length : 0,
        env_keys: envKeys,
        has_headers: Object.keys(entry.headers).length > 0,
        enabled,
        registered: true,
        used_by: null,
      });
    }

    for (const row of removed) {
      if (names.includes(row.name)) {
        // Added again outside the console.
        this.dropRemoved(row.name);
        continue;
      }
      out.push({
        name: row.name,
        scope: row.scope,
        repo_id: null,
        transport: row.transport,
        target: row.target,
        config_file: '',
        auth: row.transport === McpTransport.Stdio ? McpAuth.None : McpAuth.Oauth,
        status: HealthStatus.Auth,
        status_detail: null,
        tools: [],
        tool_count: 0,
        env_keys: [],
        has_headers: false,
        enabled: true,
        registered: false,
        used_by: null,
      });
    }
    return out;
  }

  /** A new Probe in every account, `connection.checked`, and the server as it reads now. */
  private async checked(name: string): Promise<McpServer> {
    const started = Date.now();
    this.probes.clear();
    const servers = await this.servers(true);
    const server = this.require(servers, name);
    this.store.write((_tx, emit) =>
      emit('connection.checked', {
        target: CheckTarget.McpServer,
        id: name,
        status: server.status,
        detail: server.status_detail,
        latency_ms: Date.now() - started,
      }),
    );
    return server;
  }

  private require(servers: McpServer[], name: string): McpServer {
    const server = servers.find((item) => item.name === name);
    if (!server) throw new ApiError(404, ErrorCode.NotFound, `no MCP server named ${name}`);
    return server;
  }
}

/** Project scope waits for Settings › Repos. */
function refuseProjectScope(scope: McpScope): asserts scope is RegisteredScope {
  if (scope === McpScope.Project) {
    throw new ApiError(
      400,
      ErrorCode.ValidationFailed,
      'project scope needs a Repo; Repos arrive with Settings › Repos',
    );
  }
}

function toAdd(entry: RegisteredServer): McpServerToAdd {
  return entry.transport === McpTransport.Stdio
    ? { name: entry.name, scope: entry.scope, transport: 'stdio', command: entry.command, args: entry.args }
    : {
        name: entry.name,
        scope: entry.scope,
        transport: entry.transport as 'http' | 'sse',
        url: entry.url ?? '',
        headers: entry.headers,
      };
}

/** A blank value in an edit keeps the stored one. */
function nonBlank(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
}

/** No response carries an env var or header value (Behavior 15). */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret !== '') out = out.split(secret).join('***');
  return out;
}
