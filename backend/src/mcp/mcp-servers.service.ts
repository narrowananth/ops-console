import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
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
/** `asked` holds the names the config registered when the Probe ran, so a name Claude Code leaves out is not asked about again. */
type Probed = { servers: Map<string, ProbedServer> | null; at: number; asked: Set<string> };

/** Words back into one line, quoting those `splitCommand` would split. */
export function joinCommand(words: string[]): string {
  return words.map((word) => (/[\s"']/.test(word) ? `"${word}"` : word)).join(' ');
}

/** `a "b c" d` into words. */
export function splitCommand(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

@Injectable()
export class McpServersService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('mcp');
  private readonly probes = new Map<string, Probed>();
  /** Probes under way, by account and folder. */
  private readonly probing = new Map<string, Promise<Probed>>();
  /** Env vars of launcher servers as the Keychain holds them, by server. */
  private readonly envs = new Map<string, Record<string, string>>();
  /** Servers a background Remove is taking out; they list as removed while their config still holds them. */
  private readonly leaving = new Set<string>();
  /** Background Removes, one after another. */
  private queue: Promise<void> = Promise.resolve();
  /** Bumped when the config changes, so a Probe started before then is not kept. */
  private generation = 0;
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

  /** Starts the first Probes, so the list has readings before Settings opens. */
  onApplicationBootstrap(): void {
    void this.servers().catch((error) => this.logger.warn(`first Probe failed: ${String(error)}`));
  }

  async onModuleDestroy(): Promise<void> {
    for (const login of this.logins) login.abort();
    await this.settled();
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
    return this.checkLater(body.name);
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
    return this.checkLater(name);
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
    return this.checkLater(name);
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

  /**
   * Registers the server a Connector rides on when it is missing or was removed. With `env`, a
   * registered one is registered again, so a new token takes its place.
   */
  async ensureRegistered(
    spec: { name: string; transport: McpTransport; target: string },
    env?: Record<string, string>,
  ): Promise<void> {
    const found = (await this.servers()).find((server) => server.name === spec.name);
    if (found?.registered && !env) return;
    const previous = found?.registered ? await this.registrations(spec.name) : [];
    await this.register(
      spec.name,
      McpScope.User,
      spec.transport,
      spec.target,
      env ?? {},
      {},
      previous.length > 0 ? previous : null,
    );
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

  /**
   * Remove: keeps it listed as removed and answers at once; signing out and unregistering in every account runs in
   * the background, and `connection.checked` follows. A failure lists it as registered again with why.
   */
  async remove(name: string): Promise<McpServer> {
    const current = this.require(await this.servers(), name);
    if (!current.registered) return current;
    const repo = this.repoFor(current.scope, current.repo_id ?? undefined);
    const registered = await this.registrations(name);
    this.leaving.add(name);
    this.store.write((tx) => {
      tx.insert(removedMcpServers)
        .values({ name, scope: current.scope, transport: current.transport, target: current.target })
        .onConflictDoNothing()
        .run();
    });
    this.queue = this.queue.then(() => this.unregister(name, current.scope, registered, repo));
    return this.get(name);
  }

  /** Resolves once every background Remove has finished. */
  settled(): Promise<void> {
    return this.queue;
  }

  private async unregister(
    name: string,
    scope: McpScope,
    registered: { account: Account; entry: RegisteredServer }[],
    repo: { id: string; path: string } | null,
  ): Promise<void> {
    const signedOut = repo ? this.accounts.all() : registered.map(({ account }) => account);
    // Project scope is one file in the Repo, so one `claude mcp remove` removes it for every account.
    const removeIn = repo ? registered.slice(0, 1) : registered;
    let failure: string | null = null;
    try {
      await Promise.all(
        signedOut.map((account) =>
          this.claude.mcpLogout(name, account.configDir).catch(() => {
            // Servers without a sign-in have nothing to clear.
          }),
        ),
      );
      await Promise.all(
        removeIn.map(async ({ account }) => this.claude.mcpRemove(name, scope, await this.target(account, repo))),
      );
      await this.dropEnv(name);
    } catch (error) {
      failure = error instanceof ApiError ? error.message : 'claude mcp remove failed';
      this.dropRemoved(name);
    } finally {
      this.leaving.delete(name);
      this.invalidate();
    }
    this.store.write((_tx, emit) =>
      emit('connection.checked', {
        target: CheckTarget.McpServer,
        id: name,
        status: failure ? HealthStatus.Fail : HealthStatus.Auth,
        detail: failure ? `not removed: ${failure}` : null,
        latency_ms: null,
      }),
    );
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
      if (Object.keys(env).length > 0) await this.saveEnv(name, env);
      else await this.dropEnv(name);
      // Project scope is one `.mcp.json` in the Repo, written once; the others register in every account at once.
      const results = await Promise.allSettled(
        (repo ? this.accounts.all().slice(0, 1) : this.accounts.all()).map(async (account) => {
          const where = await this.target(account, repo);
          const old = previous?.find((item) => item.account.id === account.id) ?? (repo ? previous?.[0] : undefined);
          if (old) await this.claude.mcpRemove(name, old.entry.scope, where);
          await this.claude.mcpAdd(spec, where);
          touched.push(account);
        }),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    } catch (error) {
      // A new server leaves no trace (Behavior 5); an edit that fails part way is for the operator to retry.
      if (previous === null) {
        for (const account of touched) {
          await this.claude.mcpRemove(name, spec.scope, await this.target(account, repo)).catch(() => {});
        }
        await this.dropEnv(name);
      }
      throw error;
    } finally {
      this.invalidate();
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

  private async saveEnv(name: string, env: Record<string, string>): Promise<void> {
    await this.keychain.set(secretsKey(name), JSON.stringify(env));
    this.envs.set(name, env);
  }

  private async dropEnv(name: string): Promise<void> {
    await this.keychain.delete(secretsKey(name));
    this.envs.set(name, {});
  }

  /** Read once from the Keychain, then from memory: every write to `mcp:<name>` goes through this service. */
  private async storedEnv(name: string): Promise<Record<string, string>> {
    const kept = this.envs.get(name);
    if (kept) return kept;
    const env = await this.readEnv(name);
    this.envs.set(name, env);
    return env;
  }

  private async readEnv(name: string): Promise<Record<string, string>> {
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
    return (await this.registered()).some((entry) => entry.name === name);
  }

  /**
   * What the accounts and Repos register, from the config files alone: name, scope, transport and URL. Headers and
   * env stay out. The Setup agent reads it to skip a server the console has.
   */
  async registeredServers(): Promise<{ name: string; scope: string; transport: McpTransport; url: string | null }[]> {
    const project = (await Promise.all((this.repos?.folders() ?? []).map((repo) => readProject(repo.path)))).flat();
    const seen = new Map<string, RegisteredServer>();
    for (const entry of [...(await this.registered()), ...project])
      if (!seen.has(entry.name)) seen.set(entry.name, entry);
    return [...seen.values()].map(({ name, scope, transport, url }) => ({ name, scope, transport, url }));
  }

  private async registered(): Promise<RegisteredServer[]> {
    const local = await this.localDir();
    return (await Promise.all(this.accounts.all().map((account) => readRegistered(account.configDir, local)))).flat();
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
    // Each account has its own config file, so the removals cannot clash.
    await Promise.all(
      (await this.registrations(name)).map(async ({ account, entry }) =>
        this.claude.mcpRemove(name, entry.scope, await this.target(account)),
      ),
    );
    await this.dropEnv(name);
    this.invalidate();
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

  /** Reads the config files only: the Probe takes seconds and says nothing about where a server is registered. */
  private async registrations(name: string): Promise<{ account: Account; entry: RegisteredServer }[]> {
    const accounts = this.accounts.all();
    for (const repo of this.repos?.folders() ?? []) {
      const entry = (await readProject(repo.path)).find((item) => item.name === name);
      if (entry && accounts[0]) return [{ account: accounts[0], entry }];
    }
    const local = await this.localDir();
    const found = await Promise.all(
      accounts.map(async (account) => {
        const entry = (await readRegistered(account.configDir, local)).find((item) => item.name === name);
        return entry ? [{ account, entry }] : [];
      }),
    );
    return found.flat();
  }

  /**
   * Every account with what its config registers and what the Probe reports. `fresh` waits for a new Probe;
   * otherwise the last one is used as it is and a stale or missing one is asked again in the background.
   */
  private async views(fresh: boolean) {
    const local = await this.localDir();
    return Promise.all(
      this.accounts.all().map(async (account) => {
        const entries = new Map((await readRegistered(account.configDir, local)).map((entry) => [entry.name, entry]));
        const probed = account.signedIn ? await this.probeOf(account, local, [...entries.keys()], fresh) : null;
        return {
          account,
          entries,
          probed,
          /** This account's reading of one server; `null` when the account does not register it or is signed out. */
          state(name: string): Reading | null {
            if (!entries.has(name) || probed === null) return null;
            if (probed === undefined || !probed.asked.has(name)) {
              return { status: HealthStatus.Checking, detail: null, tools: [] };
            }
            return readServer(account, probed, name);
          },
        };
      }),
    );
  }

  /** The kept Probe, or with `fresh` a new one; `undefined` when none has run yet and one is on its way. */
  private async probeOf(account: Account, cwd: string, names: string[], fresh: true): Promise<Probed>;
  private async probeOf(account: Account, cwd: string, names: string[], fresh: boolean): Promise<Probed | undefined>;
  private async probeOf(account: Account, cwd: string, names: string[], fresh: boolean): Promise<Probed | undefined> {
    const key = `${account.configDir}\n${cwd}`;
    if (fresh) return this.runProbe(key, account, cwd, names);
    const kept = this.probes.get(key);
    // A server added outside the console after the Probe ran is not in it: ask again (Behavior 14).
    const added = kept && names.some((name) => !kept.asked.has(name));
    if (!kept || added || Date.now() - kept.at >= PROBE_TTL_MS) {
      void this.runProbe(key, account, cwd, names).catch(() => {});
    }
    return kept;
  }

  /** The config changed: a Probe under way is not kept, and the kept ones stay shown until new ones answer. */
  private invalidate(): void {
    this.generation += 1;
    this.probing.clear();
    for (const [key, probed] of this.probes) this.probes.set(key, { ...probed, at: 0 });
  }

  /** One Probe per account and folder at a time; a changed reading sends `connection.checked`. */
  private runProbe(key: string, account: Account, cwd: string, names: string[]): Promise<Probed> {
    const running = this.probing.get(key);
    if (running) return running;
    const generation = this.generation;
    const run = (async () => {
      let result: Probed;
      try {
        const servers = await this.probe.run(account.configDir, cwd);
        result = {
          servers: new Map(servers.map((server) => [server.name, server])),
          at: Date.now(),
          asked: new Set(names),
        };
      } catch {
        result = { servers: null, at: Date.now(), asked: new Set(names) };
      }
      if (generation !== this.generation) return result;
      const before = this.probes.get(key);
      this.probes.set(key, result);
      this.announce(before, result, names);
      return result;
    })().finally(() => {
      if (this.probing.get(key) === run) this.probing.delete(key);
    });
    this.probing.set(key, run);
    return run;
  }

  /** `connection.checked` for each server whose reading moved, so an open list reads again. */
  private announce(before: Probed | undefined, after: Probed, names: string[]): void {
    const read = (probed: Probed | undefined, name: string) => {
      const server = probed?.servers?.get(name);
      return probed === undefined ? 'unread' : `${probed.servers === null}|${server?.status}|${server?.tools.length}`;
    };
    const moved = names.filter((name) => read(before, name) !== read(after, name));
    if (moved.length === 0) return;
    this.store.write((_tx, emit) => {
      for (const name of moved) {
        const server = after.servers?.get(name);
        emit('connection.checked', {
          target: CheckTarget.McpServer,
          id: name,
          status: server?.status === 'connected' ? HealthStatus.Ok : server ? HealthStatus.Auth : HealthStatus.Fail,
          detail: server?.error ?? null,
          latency_ms: null,
        });
      }
    });
  }

  /** The servers in each Repo's `.mcp.json`, with each signed-in account's reading. A name a user or local server holds wins. */
  private async projectItems(fresh: boolean) {
    const accounts = this.accounts.all();
    const items: { name: string; entry: RegisteredServer; repoId: string; file: string; states: Reading[] }[] = [];
    for (const repo of this.repos?.folders() ?? []) {
      const entries = await readProject(repo.path);
      const names = entries.map((entry) => entry.name);
      for (const entry of entries) {
        const states: Reading[] = [];
        for (const account of accounts.filter((item) => item.signedIn)) {
          const probed = await this.probeOf(account, repo.path, names, fresh);
          states.push(
            probed === undefined || !probed.asked.has(entry.name)
              ? { status: HealthStatus.Checking, detail: null, tools: [] }
              : probed.servers !== null && !probed.servers.has(entry.name)
                ? { status: HealthStatus.Auth, detail: `${account.label}: pending approval in Claude Code`, tools: [] }
                : readServer(account, probed, entry.name),
          );
        }
        items.push({ name: entry.name, entry, repoId: repo.id, file: path.join(repo.path, '.mcp.json'), states });
      }
    }
    return items;
  }

  /** Every server as the kept Probes read it; `fresh` waits for new ones. */
  private async servers(fresh = false): Promise<McpServer[]> {
    const views = await this.views(fresh);
    const disabled = new Set(
      this.store.db
        .select()
        .from(disabledMcpServers)
        .all()
        .map((row) => row.name),
    );
    const removed = this.store.db.select().from(removedMcpServers).all();
    const userNames = [...new Set(views.flatMap((view) => [...view.entries.keys()]))].filter(
      (name) => !this.leaving.has(name),
    );
    const project = (await this.projectItems(fresh)).filter(
      (item) => !userNames.includes(item.name) && !this.leaving.has(item.name),
    );
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

  /** The server as it reads now, with a new Probe in the background; `connection.checked` reports it. */
  private async checkLater(name: string): Promise<McpServer> {
    this.invalidate();
    void this.checked(name).catch((error) => this.logger.warn(`checking ${name} failed: ${String(error)}`));
    return this.get(name);
  }

  /** A new Probe in every account, `connection.checked`, and the server as it reads now. */
  private async checked(name: string): Promise<McpServer> {
    const started = Date.now();
    this.invalidate();
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
