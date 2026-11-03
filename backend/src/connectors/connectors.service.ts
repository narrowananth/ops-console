import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  CheckTarget,
  CONNECTOR_NAMES,
  CONNECTOR_ORDER,
  CONNECTOR_SERVERS,
  CONNECTOR_VIA,
  type Connector,
  type ConnectorCheck,
  ConnectorId,
  connectorConfigSchemas,
  ErrorCode,
  HealthStatus,
  type McpServer,
} from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { ApiError, validationFailed } from '../common/errors';
import { mergeConfig } from '../common/merge-config';
import { connectors } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { McpServersService } from '../mcp/mcp-servers.service';
import { CONNECTOR_TOOLS, type ConnectorTools, type SignInPrompt } from './connector-tools';

type Row = typeof connectors.$inferSelect;

/** A connected Connector is checked again on a list read when its last check is older than this. */
export const RECHECK_AFTER_MS = 10 * 60_000;

type Reading = { status: HealthStatus; detail: string | null; accountLabel: string | null; login: string | null };

@Injectable()
export class ConnectorsService implements OnModuleDestroy {
  private readonly logger = new Logger('connectors');
  /** Sign-ins waiting on the operator, by Connector, with what the browser step needs. */
  private readonly signIns = new Map<ConnectorId, AbortController>();
  private readonly prompts = new Map<ConnectorId, SignInPrompt>();
  private readonly rechecking = new Set<ConnectorId>();
  /** Every sign-in still running, stopped or not: shutdown waits for them to let go of the store. */
  private readonly running = new Set<Promise<void>>();
  private stopping = false;

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(CONNECTOR_TOOLS) private readonly tools: ConnectorTools,
    @Inject(McpServersService) private readonly mcp: McpServersService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    for (const signIn of this.signIns.values()) signIn.abort();
    await Promise.allSettled(this.running);
  }

  async list(): Promise<{ data: Connector[]; meta: { next_cursor: null } }> {
    await this.follow();
    const rows = this.rows();
    const stale = rows.filter((row) => row.status !== HealthStatus.Off && isStale(row.lastCheckedAt));
    for (const row of stale) void this.recheck(row.id);
    return { data: await Promise.all(rows.map((row) => this.view(row))), meta: { next_cursor: null } };
  }

  async get(id: ConnectorId): Promise<Connector> {
    return this.view(this.row(id));
  }

  /** Refuses an action whose Connector is not connected and healthy; nothing is started. */
  require(id: ConnectorId): void {
    const row = this.row(id);
    if (row.status !== HealthStatus.Ok) {
      throw new ApiError(409, ErrorCode.ConnectorNotConnected, `${CONNECTOR_NAMES[id]} is not connected`);
    }
  }

  /** Blank fields keep their value; a bad value names the fields and saves nothing. */
  async update(id: ConnectorId, changes: Record<string, unknown>): Promise<Connector> {
    const row = this.row(id);
    const merged = mergeConfig(JSON.parse(row.config) as Record<string, unknown>, changes);
    const parsed = connectorConfigSchemas[id].safeParse(merged);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'config'))];
      throw validationFailed(`invalid config: ${fields.join(', ')}`);
    }
    this.store.write((tx) => {
      tx.update(connectors)
        .set({ config: JSON.stringify(parsed.data) })
        .where(eq(connectors.id, id))
        .run();
    });
    return this.get(id);
  }

  /**
   * Starts the provider's own browser sign-in and answers at once. `sign_in` holds what the browser step needs until it
   * ends; `connection.checked` reports each change and the result.
   */
  async connect(id: ConnectorId): Promise<void> {
    this.signIns.get(id)?.abort();
    const abort = new AbortController();
    this.signIns.set(id, abort);
    this.prompt(id, { code: null, url: null });
    const run = this.signIn(id, abort.signal)
      .catch((error) => {
        if (!abort.signal.aborted) this.fail(id, error);
      })
      .finally(() => {
        this.running.delete(run);
        if (this.signIns.get(id) !== abort) return;
        this.signIns.delete(id);
        this.prompts.delete(id);
        if (!this.stopping) this.announce(id);
      });
    this.running.add(run);
  }

  /**
   * Cancel: stops a sign-in still waiting on the browser, and the Connector keeps the status it had before Connect.
   * With no sign-in under way it answers with the Connector as it is.
   */
  cancelSignIn(id: ConnectorId): Promise<Connector> {
    const abort = this.signIns.get(id);
    if (abort) {
      abort.abort();
      this.signIns.delete(id);
      this.prompts.delete(id);
      this.announce(id);
    }
    return this.get(id);
  }

  async check(id: ConnectorId): Promise<ConnectorCheck> {
    const started = new Date().toISOString();
    const row = this.row(id);
    const reading = await this.read(id, row).catch((error): Reading => unreachable(error));
    // A sign-in that ended while this check ran recorded what it found; this older reading must not replace it.
    const now = this.row(id);
    if (now.lastCheckedAt !== null && now.lastCheckedAt > started) {
      return {
        status: now.status,
        status_detail: now.statusDetail,
        account_label: now.accountLabel,
        login: now.login,
        last_checked_at: now.lastCheckedAt,
      };
    }
    return this.record(id, reading);
  }

  /** Clears what the console stored. The CLIs stay signed in for the operator's terminal. */
  async disconnect(id: ConnectorId): Promise<Connector> {
    this.signIns.get(id)?.abort();
    this.prompts.delete(id);
    const server = CONNECTOR_SERVERS[id];
    if (server && !this.sharedServer(id, server.name)) {
      const found = await this.mcp.find(server.name);
      if (found?.registered) await this.mcp.remove(server.name);
    }
    this.store.write((tx) => {
      tx.update(connectors)
        .set({ status: HealthStatus.Off, statusDetail: null, accountLabel: null, login: null })
        .where(eq(connectors.id, id))
        .run();
    });
    return this.get(id);
  }

  private async signIn(id: ConnectorId, signal: AbortSignal): Promise<void> {
    const config = JSON.parse(this.row(id).config) as Record<string, string>;
    const onPrompt = (prompt: SignInPrompt) => {
      if (!signal.aborted) this.prompt(id, prompt);
    };
    switch (id) {
      case ConnectorId.Datadog:
        await this.tools.datadogLogin(config.site ?? 'datadoghq.com', signal, onPrompt);
        await this.landed(id, signal);
        if (signal.aborted) return;
        if (await this.tools.datadogHasMcp()) await this.mcp.ensureRegistered(CONNECTOR_SERVERS[id] as McpSpec);
        return;
      case ConnectorId.Github: {
        await this.installMissing(['gh', 'github-mcp-server']);
        await this.tools.githubLogin(signal, onPrompt);
        const token = await this.tools.githubToken();
        if (!token) throw new ApiError(409, ErrorCode.InvalidState, 'gh did not finish signing in');
        await this.landed(id, signal);
        if (signal.aborted) return;
        // The token reaches the server through the Keychain and the launcher, never Claude Code's config.
        await this.mcp.ensureRegistered(CONNECTOR_SERVERS[id] as McpSpec, { GITHUB_PERSONAL_ACCESS_TOKEN: token });
        return;
      }
      case ConnectorId.Gitlab: {
        const host = config.host ?? 'gitlab.com';
        await this.installMissing(['glab']);
        // `glab` asks to confirm before signing in again, with no flag to skip it.
        if ((await this.tools.gitlabUser(host)) === null) await this.tools.gitlabLogin(host, signal, onPrompt);
        break;
      }
      case ConnectorId.Bitbucket: {
        // The Atlassian server lets the agent open pull requests; `bkt` reads them with no model turn.
        const server = CONNECTOR_SERVERS[id] as McpSpec;
        const added = await this.mcp.ensureRegistered(server);
        await this.mcp.authenticateAndCheck(server.name, { signal, added });
        if (signal.aborted) return;
        if (!(await this.tools.installed('bkt'))) {
          throw new ApiError(
            409,
            ErrorCode.InvalidState,
            'bkt is not installed: install it from github.com/avivsinai/bitbucket-cli, then Connect again',
          );
        }
        if ((await this.tools.bitbucketUser()) === null) await this.tools.bitbucketLogin(signal, onPrompt);
        break;
      }
      case ConnectorId.Slashdocs: {
        if (!(await this.tools.installed('slashdocs'))) {
          throw new ApiError(
            409,
            ErrorCode.InvalidState,
            'slashdocs is not installed: install the slashdocs CLI, then Connect again',
          );
        }
        // Already signed in, in the operator's terminal: nothing to open.
        if ((await this.tools.slashdocsUser()) === null) {
          await this.tools.slashdocsLogin(config.server?.trim() || null, signal, onPrompt);
        }
        break;
      }
      case ConnectorId.Shopify: {
        const server = CONNECTOR_SERVERS[id] as McpSpec;
        await this.mcp.ensureRegistered(server);
        const found = await this.mcp.checkOne(server.name);
        if (!signal.aborted) this.record(id, serverReading(found, config));
        return;
      }
      default: {
        const server = CONNECTOR_SERVERS[id] as McpSpec;
        const added = await this.mcp.ensureRegistered(server);
        const found = await this.mcp.authenticateAndCheck(server.name, { signal, added });
        // The sign-in already read the server; checking again would wait for a new Probe in every account.
        if (!signal.aborted) this.record(id, serverReading(found, config));
        return;
      }
    }
    await this.landed(id, signal);
  }

  /**
   * The provider's sign-in finished: the drawer stops waiting and the check records the account at once. Steps after
   * it, such as registering the MCP server, run on; one that fails records why.
   */
  private async landed(id: ConnectorId, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    this.prompts.delete(id);
    await this.check(id);
  }

  /** Installs each command not on the PATH from Homebrew; its formula has the command's name. */
  private async installMissing(commands: string[]): Promise<void> {
    for (const command of commands) {
      if (await this.tools.installed(command)) continue;
      if (!(await this.tools.installed('brew'))) {
        throw new ApiError(
          409,
          ErrorCode.InvalidState,
          `${command} is not installed and Homebrew is missing: install Homebrew from brew.sh, then Connect again`,
        );
      }
      await this.tools.install(command);
    }
  }

  /** A sign-in that fails or is cancelled leaves `auth` with the reason (Behavior 6). */
  private fail(id: ConnectorId, error: unknown): void {
    this.logger.warn(`${id} sign-in did not finish`);
    const detail = error instanceof ApiError ? error.message : 'the sign-in did not finish';
    this.record(id, { status: HealthStatus.Auth, detail, accountLabel: null, login: null });
  }

  private async read(id: ConnectorId, row: Row): Promise<Reading> {
    const config = JSON.parse(row.config) as Record<string, string | null>;
    const signedOut = (detail: string): Reading => ({
      status: HealthStatus.Auth,
      detail,
      accountLabel: null,
      login: null,
    });
    switch (id) {
      case ConnectorId.Datadog: {
        const status = await this.tools.datadogStatus();
        return status.signedIn
          ? { status: HealthStatus.Ok, detail: null, accountLabel: status.org ?? config.site ?? null, login: null }
          : signedOut('pup is not signed in');
      }
      case ConnectorId.Github: {
        const login = await this.tools.githubUser();
        return login === null
          ? signedOut('gh is not signed in')
          : { status: HealthStatus.Ok, detail: null, accountLabel: config.org ?? login, login };
      }
      case ConnectorId.Gitlab: {
        const login = await this.tools.gitlabUser(config.host ?? 'gitlab.com');
        return login === null
          ? signedOut('glab is not signed in')
          : { status: HealthStatus.Ok, detail: null, accountLabel: config.host ?? null, login };
      }
      case ConnectorId.Bitbucket: {
        const login = await this.tools.bitbucketUser();
        return login === null
          ? signedOut('bkt is not signed in, or macOS did not let it read its Keychain item')
          : { status: HealthStatus.Ok, detail: null, accountLabel: config.workspace || login, login };
      }
      case ConnectorId.Slashdocs: {
        const user = await this.tools.slashdocsUser();
        return user === null
          ? signedOut('slashdocs is not signed in')
          : { status: HealthStatus.Ok, detail: null, accountLabel: config.server || null, login: user.email };
      }
      default: {
        const server = CONNECTOR_SERVERS[id] as McpSpec;
        const found = await this.mcp.checkOne(server.name).catch(() => null);
        if (found === null || !found.registered) return signedOut(`${server.name} is not registered`);
        return serverReading(found, config);
      }
    }
  }

  private record(id: ConnectorId, reading: Reading): ConnectorCheck {
    const at = new Date().toISOString();
    this.store.write((tx, emit) => {
      tx.update(connectors)
        .set({
          status: reading.status,
          statusDetail: reading.detail,
          accountLabel: reading.accountLabel,
          login: reading.login,
          lastCheckedAt: at,
        })
        .where(eq(connectors.id, id))
        .run();
      emit('connection.checked', {
        target: CheckTarget.Connector,
        id,
        status: reading.status,
        detail: reading.detail,
        latency_ms: null,
      });
    });
    return {
      status: reading.status,
      status_detail: reading.detail,
      account_label: reading.accountLabel,
      login: reading.login,
      last_checked_at: at,
    };
  }

  /**
   * A Connector reached only through its MCP server reads as the server reads now, from the kept Probes: a server
   * that recovers or breaks moves the Connector at once instead of at its next check.
   */
  private async follow(): Promise<void> {
    const riders = this.rows().filter(
      (row) => SERVER_ONLY.includes(row.id) && row.status !== HealthStatus.Off && !this.signIns.has(row.id),
    );
    if (riders.length === 0) return;
    const servers = await this.mcp.list().catch(() => null);
    for (const row of riders) {
      const found = servers?.data.find((server) => server.name === CONNECTOR_SERVERS[row.id]?.name);
      if (!found?.registered || found.status === HealthStatus.Checking) continue;
      const reading = serverReading(found, JSON.parse(row.config) as Record<string, string | null>);
      // Same status: the stored reason stays, such as why the last sign-in failed.
      if (reading.status !== row.status) this.record(row.id, reading);
    }
  }

  private async recheck(id: ConnectorId): Promise<void> {
    // A sign-in under way records its own result.
    if (this.rechecking.has(id) || this.signIns.has(id)) return;
    this.rechecking.add(id);
    try {
      await this.check(id);
    } catch (error) {
      this.logger.warn(`checking ${id} failed: ${String(error)}`);
    } finally {
      this.rechecking.delete(id);
    }
  }

  private async view(row: Row): Promise<Connector> {
    return {
      id: row.id,
      name: CONNECTOR_NAMES[row.id],
      via: CONNECTOR_VIA[row.id],
      status: row.status,
      status_detail: row.statusDetail,
      account_label: row.accountLabel,
      login: row.login,
      config: JSON.parse(row.config) as Record<string, unknown>,
      last_checked_at: row.lastCheckedAt,
      sign_in: this.prompts.get(row.id) ?? null,
    };
  }

  /** Keeps what the browser step needs and tells the drawer. */
  private prompt(id: ConnectorId, prompt: SignInPrompt): void {
    this.prompts.set(id, prompt);
    this.announce(id);
  }

  private announce(id: ConnectorId): void {
    const row = this.row(id);
    this.store.write((_tx, emit) => {
      emit('connection.checked', {
        target: CheckTarget.Connector,
        id,
        status: row.status,
        detail: row.statusDetail,
        latency_ms: null,
      });
    });
  }

  /** Whether another connected Connector rides the same MCP server, so Disconnect must leave it. */
  private sharedServer(id: ConnectorId, name: string): boolean {
    return this.rows().some(
      (row) => row.id !== id && row.status !== HealthStatus.Off && CONNECTOR_SERVERS[row.id]?.name === name,
    );
  }

  private rows(): Row[] {
    const all = this.store.db.select().from(connectors).all();
    return CONNECTOR_ORDER.flatMap((id) => all.filter((row) => row.id === id));
  }

  private row(id: ConnectorId): Row {
    const row = this.store.db.select().from(connectors).where(eq(connectors.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Connector');
    return row;
  }
}

/** Connectors with no CLI of their own: their status is their MCP server's. */
const SERVER_ONLY: ConnectorId[] = [ConnectorId.Jira, ConnectorId.Slack, ConnectorId.Sentry, ConnectorId.Shopify];

type McpSpec = NonNullable<(typeof CONNECTOR_SERVERS)[ConnectorId]>;

function isStale(lastCheckedAt: string | null): boolean {
  return lastCheckedAt === null || Date.now() - Date.parse(lastCheckedAt) > RECHECK_AFTER_MS;
}

function unreachable(error: unknown): Reading {
  const detail = error instanceof ApiError ? error.message : 'the check did not finish';
  return { status: HealthStatus.Fail, detail, accountLabel: null, login: null };
}

/** A Connector that rides an MCP Server reads as the server does. */
function serverReading(found: McpServer, config: Record<string, string | null>): Reading {
  const off = found.status === HealthStatus.Off;
  return {
    status: off ? HealthStatus.Fail : found.status,
    detail: off ? `${found.name} is turned off in MCP servers` : found.status_detail,
    accountLabel: config.workspace || config.org || config.site || null,
    login: null,
  };
}
