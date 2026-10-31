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

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(CONNECTOR_TOOLS) private readonly tools: ConnectorTools,
    @Inject(McpServersService) private readonly mcp: McpServersService,
  ) {}

  onModuleDestroy(): void {
    for (const signIn of this.signIns.values()) signIn.abort();
  }

  async list(): Promise<{ data: Connector[]; meta: { next_cursor: null } }> {
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
    void this.signIn(id, abort.signal)
      .catch((error) => {
        if (!abort.signal.aborted) this.fail(id, error);
      })
      .finally(() => {
        if (this.signIns.get(id) !== abort) return;
        this.signIns.delete(id);
        this.prompts.delete(id);
        this.announce(id);
      });
  }

  async check(id: ConnectorId): Promise<ConnectorCheck> {
    const row = this.row(id);
    const reading = await this.read(id, row).catch((error): Reading => unreachable(error));
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
        if (await this.tools.datadogHasMcp()) await this.mcp.ensureRegistered(CONNECTOR_SERVERS[id] as McpSpec);
        break;
      case ConnectorId.Github: {
        await this.installMissing(['gh', 'github-mcp-server']);
        await this.tools.githubLogin(signal, onPrompt);
        const token = await this.tools.githubToken();
        if (!token) throw new ApiError(409, ErrorCode.InvalidState, 'gh did not finish signing in');
        // The token reaches the server through the Keychain and the launcher, never Claude Code's config.
        await this.mcp.ensureRegistered(CONNECTOR_SERVERS[id] as McpSpec, { GITHUB_PERSONAL_ACCESS_TOKEN: token });
        break;
      }
      case ConnectorId.Gitlab: {
        const host = config.host ?? 'gitlab.com';
        await this.installMissing(['glab']);
        // `glab` asks to confirm before signing in again, with no flag to skip it.
        if ((await this.tools.gitlabUser(host)) === null) await this.tools.gitlabLogin(host, signal, onPrompt);
        break;
      }
      case ConnectorId.Shopify:
        await this.mcp.ensureRegistered(CONNECTOR_SERVERS[id] as McpSpec);
        break;
      default: {
        const server = CONNECTOR_SERVERS[id] as McpSpec;
        await this.mcp.ensureRegistered(server);
        await this.mcp.authenticateAndCheck(server.name);
      }
    }
    if (signal.aborted) return;
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
      default: {
        const server = CONNECTOR_SERVERS[id] as McpSpec;
        const found = await this.mcp.recheck(server.name).catch(() => null);
        if (found === null || !found.registered) return signedOut(`${server.name} is not registered`);
        return {
          status: found.status === HealthStatus.Off ? HealthStatus.Fail : found.status,
          detail: found.status_detail,
          accountLabel: config.workspace || config.org || config.site || null,
          login: null,
        };
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

  private async recheck(id: ConnectorId): Promise<void> {
    if (this.rechecking.has(id)) return;
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

type McpSpec = NonNullable<(typeof CONNECTOR_SERVERS)[ConnectorId]>;

function isStale(lastCheckedAt: string | null): boolean {
  return lastCheckedAt === null || Date.now() - Date.parse(lastCheckedAt) > RECHECK_AFTER_MS;
}

function unreachable(error: unknown): Reading {
  const detail = error instanceof ApiError ? error.message : 'the check did not finish';
  return { status: HealthStatus.Fail, detail, accountLabel: null, login: null };
}
