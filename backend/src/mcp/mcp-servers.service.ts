import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Logger, type OnModuleDestroy, Optional } from '@nestjs/common';
import {
  CheckTarget,
  CONNECTOR_SERVERS,
  type ConnectorId,
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
import { ReposService } from '../repos/repos.service';
import { configFile, type RegisteredServer, readProject, readRegistered } from './claude-config';
import { launcherArgv, parseEnv, secretsKey, unwrapLauncher } from './launcher';
import { PROBE, type Probe, type ProbedServer } from './probe';

/** Names of the servers that back a Connection. Settings › Connections owns them; the MCP list leaves them out. */
@Injectable()
export class ConnectionServers {
  private source: () => string[] = () => [];

  use(source: () => string[]): void {
    this.source = source;
  }

  names(): Set<string> {
    return new Set(this.source());
  }
}

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
    @Inject(ConnectionServers) private readonly connectionServers: ConnectionServers,
    @Optional() @Inject(ReposService) private readonly repos?: ReposService,
  ) {}

  onModuleDestroy(): void {
    for (const login of this.logins) login.abort();
  }

  async list(): Promise<{ data: McpServer[]; meta: { next_cursor: null; connection_server_count: number } }> {
    const hidden = this.connectionServers.names();
    const all = await this.servers();
    return {
      data: all.filter((server) => !hidden.has(server.name)),
      meta: { next_cursor: null, connection_server_count: all.filter((server) => hidden.has(server.name)).length },
    };
  }

  async get(name: string): Promise<McpServer> {
    return this.require(await this.servers(), name);
  }

  async create(body: CreateMcpServer): Promise<McpServer> {
    const repo = this.repoFor(body.scope, body.repo_id);
    const existing = await this.servers();
    if (existing.some((server) => server.name === body.name) || this.connectionNames().has(body.name)) {
      throw new ApiError(409, ErrorCode.Duplicate, `${body.name} is already used`);
    }
    await this.register(
      body.name,
      body.scope,
      body.transport,
      body.target,
      body.env ?? {},
      body.headers ?? {},
      null,
      repo,
    );
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
    const moves = body.scope !== undefined && body.scope !== current.scope;
    if (moves && (body.scope === McpScope.Project || current.scope === McpScope.Project)) {
      throw new ApiError(
        400,
        ErrorCode.ValidationFailed,
        'a server cannot move to or from project scope; add it again',
      );
    }
    const scope = body.scope ?? current.scope;
    const repo = this.repoFor(scope, current.repo_id ?? undefined);
    const previous = await this.registrations(name);
    const first = previous[0]?.entry;
    const target = body.target ?? current.target;
    const env = transport === McpTransport.Stdio ? await this.mergedEnv(name, body.env ?? {}) : {};
    const headers = { ...(first?.headers ?? {}), ...nonBlank(body.headers ?? {}) };
    await this.register(
      name,
      scope,
      transport,
      target,
      env,
      transport === McpTransport.Stdio ? {} : headers,
      previous,
      repo,
    );
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
    await this.authenticatePrepare(name);
    const views = await this.views(true);
    const waiting = views.filter((view) => view.state(name)?.status === HealthStatus.Auth);
    void this.signIn(
      name,
      waiting.map((view) => view.account),
    ).catch((error) => {
      this.logger.error(`checking ${name} after sign-in failed: ${String(error)}`);
    });
  }

  /** A removed http or sse server is registered again from its row; a stdio one needs its env vars first. */
  private async authenticatePrepare(name: string): Promise<void> {
    const current = this.require(await this.servers(), name);
    if (current.registered) return;
    if (current.transport === McpTransport.Stdio) {
      throw new ApiError(409, ErrorCode.InvalidState, `${name} has no sign-in; add it again with its env vars`);
    }
    const repo = this.repoFor(current.scope, current.repo_id ?? undefined);
    await this.register(name, current.scope, current.transport, current.target, {}, {}, null, repo);
  }

  /** Authenticate, waiting for the sign-ins and the check. Connectors follow the result. */
  async authenticateAndCheck(name: string): Promise<McpServer> {
    await this.authenticatePrepare(name);
    const views = await this.views(true);
    const waiting = views.filter((view) => view.state(name)?.status === HealthStatus.Auth);
    return this.signIn(
      name,
      waiting.map((view) => view.account),
    );
  }

  /** Registers a server a Connector rides on when it is missing or was removed. */
  async ensureRegistered(spec: { name: string; transport: McpTransport; target: string }): Promise<void> {
    const found = (await this.servers()).find((server) => server.name === spec.name);
    if (found?.registered) return;
    await this.register(spec.name, McpScope.User, spec.transport, spec.target, {}, {}, null);
    this.dropRemoved(spec.name);
  }

  /** The server as it reads now, without a new Probe; `null` when it is unknown. */
  async find(name: string): Promise<McpServer | null> {
    return (await this.servers()).find((server) => server.name === name) ?? null;
  }

  /** Probes again and sends `connection.checked`. */
  recheck(name: string): Promise<McpServer> {
    return this.checked(name);
  }

  private async signIn(name: string, accounts: Account[]): Promise<McpServer> {
    const abort = new AbortController();
    this.logins.add(abort);
    try {
      for (const account of accounts) {
        try {
          await this.claude.mcpLogin(name, account.configDir, abort.signal);
        } catch {
          this.logger.warn(`sign-in to ${name} did not finish in account ${account.label}`);
        }
      }
      return await this.checked(name);
    } finally {
      this.logins.delete(abort);
    }
  }

  /** Remove: signs out and unregisters the server in every account, and keeps it listed. */
  async remove(name: string): Promise<McpServer> {
    const current = this.require(await this.servers(), name);
    if (!current.registered) return current;
    const repo = this.repoFor(current.scope, current.repo_id ?? undefined);
    const registered = await this.registrations(name);
    for (const { account } of repo ? this.accounts.all().map((account) => ({ account })) : registered) {
      try {
        await this.claude.mcpLogout(name, account.configDir);
      } catch {
        // Servers without a sign-in have nothing to clear.
      }
    }
    // Project scope is one file in the Repo, so one `claude mcp remove` removes it for every account.
    for (const { account } of repo ? registered.slice(0, 1) : registered) {
      await this.claude.mcpRemove(name, current.scope, await this.target(account, repo));
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
    scope: McpScope,
    transport: McpTransport,
    target: string,
    env: Record<string, string>,
    headers: Record<string, string>,
    previous: { account: Account; entry: RegisteredServer }[] | null,
    repo: { id: string; path: string } | null = null,
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
      // Project scope is one `.mcp.json` in the Repo, written once; the others register in every account.
      for (const account of repo ? this.accounts.all().slice(0, 1) : this.accounts.all()) {
        const where = await this.target(account, repo);
        const old = previous?.find((item) => item.account.id === account.id) ?? (repo ? previous?.[0] : undefined);
        if (old) await this.claude.mcpRemove(name, old.entry.scope, where);
        await this.claude.mcpAdd(spec, where);
        touched.push(account);
      }
    } catch (error) {
      // A new server leaves no trace (Behavior 5); an edit that fails part way is for the operator to retry.
      if (previous === null) {
        for (const account of touched) {
          await this.claude.mcpRemove(name, spec.scope, await this.target(account, repo)).catch(() => {});
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
    scope: McpScope,
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

  private connectionNames(): Set<string> {
    return this.connectionServers.names();
  }

  /** Whether any account registers a server of this name, hidden or not. */
  async exists(name: string): Promise<boolean> {
    const views = await this.views(false);
    return views.some((view) => view.entries.has(name));
  }

  /** Registers a Connection's server in every account, replacing the one there. The env vars go to the Keychain. */
  async registerConnectionServer(name: string, target: string, env: Record<string, string>): Promise<void> {
    const previous = await this.registrations(name);
    await this.register(
      name,
      McpScope.User,
      McpTransport.Stdio,
      target,
      env,
      {},
      previous.length > 0 ? previous : null,
    );
  }

  /** Removes a Connection's server from every account and the Keychain; no row is kept. */
  async unregisterConnectionServer(name: string): Promise<void> {
    for (const { account, entry } of await this.registrations(name)) {
      await this.claude.mcpRemove(name, entry.scope, await this.target(account));
    }
    await this.keychain.delete(secretsKey(name));
    this.probes.clear();
  }

  private async localDir(): Promise<string> {
    const dir = path.join(this.dataDir, 'mcp-local');
    await mkdir(dir, { recursive: true });
    return realpath(dir);
  }

  private async target(account: Account, repo: { path: string } | null = null): Promise<McpTarget> {
    return { configDir: account.configDir, cwd: repo?.path ?? (await this.localDir()) };
  }

  /** The Repo a project scope server belongs to; other scopes have none. */
  private repoFor(scope: McpScope, repoId: string | undefined): { id: string; path: string } | null {
    if (scope !== McpScope.Project) return null;
    const repo = repoId === undefined ? undefined : this.repos?.folders().find((item) => item.id === repoId);
    if (!repo) throw new ApiError(400, ErrorCode.ValidationFailed, 'project scope needs a Repo: invalid body: repo_id');
    return repo;
  }

  private async registrations(name: string): Promise<{ account: Account; entry: RegisteredServer }[]> {
    const project = (await this.projectItems(false)).find((item) => item.name === name);
    const first = this.accounts.all()[0];
    if (project && first) return [{ account: first, entry: project.entry }];
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
          state(name: string): Reading | null {
            if (!entries.has(name) || probed === null) return null;
            return readServer(account, probed, name);
          },
        };
      }),
    );
  }

  private async probeOf(account: Account, local: string, force: boolean): Promise<Probed> {
    const key = `${account.configDir}\n${local}`;
    const kept = this.probes.get(key);
    if (!force && kept && Date.now() - kept.at < PROBE_TTL_MS) return kept;
    let result: Probed;
    try {
      const servers = await this.probe.run(account.configDir, local);
      result = { servers: new Map(servers.map((server) => [server.name, server])), at: Date.now() };
    } catch {
      result = { servers: null, at: Date.now() };
    }
    this.probes.set(key, result);
    return result;
  }

  /** The servers in each Repo's `.mcp.json`, with each signed-in account's reading. A name a user or local server holds wins. */
  private async projectItems(force: boolean) {
    const accounts = this.accounts.all();
    const items: { name: string; entry: RegisteredServer; repoId: string; file: string; states: Reading[] }[] = [];
    for (const repo of this.repos?.folders() ?? []) {
      for (const entry of await readProject(repo.path)) {
        const states: Reading[] = [];
        for (const account of accounts.filter((item) => item.signedIn)) {
          const probed = await this.probeOf(account, repo.path, force);
          states.push(
            probed.servers !== null && !probed.servers.has(entry.name)
              ? { status: HealthStatus.Auth, detail: `${account.label}: pending approval in Claude Code`, tools: [] }
              : readServer(account, probed, entry.name),
          );
        }
        items.push({ name: entry.name, entry, repoId: repo.id, file: path.join(repo.path, '.mcp.json'), states });
      }
    }
    return items;
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
    const userNames = [...new Set(views.flatMap((view) => [...view.entries.keys()]))];
    const project = (await this.projectItems(force)).filter((item) => !userNames.includes(item.name));
    const names = [...userNames, ...project.map((item) => item.name)];
    const out: McpServer[] = [];

    for (const name of names) {
      const owner = views.find((view) => view.entries.has(name));
      const projectItem = project.find((item) => item.name === name);
      const entry = owner?.entries.get(name) ?? projectItem?.entry;
      if (!entry) continue;
      const unwrapped = unwrapLauncher(this.config.launcher, entry.command, entry.args);
      const own = unwrapped ?? entry;
      const target =
        entry.transport === McpTransport.Stdio ? joinCommand([own.command, ...own.args]) : (entry.url ?? '');
      const envKeys = unwrapped ? Object.keys(await this.storedEnv(name)).sort() : [];
      const states =
        projectItem?.states ??
        views.flatMap((view) => {
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
        scope: projectItem ? McpScope.Project : entry.scope,
        repo_id: projectItem?.repoId ?? null,
        transport: entry.transport,
        target: scrub(target, secrets),
        config_file: projectItem
          ? projectItem.file
          : configFile((owner as NonNullable<typeof owner>).account.configDir),
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
        used_by: usedBy(name),
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
        used_by: usedBy(row.name),
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

/** The Connector whose server this is. */
function usedBy(name: string): ConnectorId | null {
  const found = Object.entries(CONNECTOR_SERVERS).find(([, server]) => server?.name === name);
  return (found?.[0] as ConnectorId | undefined) ?? null;
}

type Reading = { status: HealthStatus; detail: string | null; tools: string[] };

/** One account's reading of a server from its Probe. */
function readServer(account: Account, probed: Probed, name: string): Reading {
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
