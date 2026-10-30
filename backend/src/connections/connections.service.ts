import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AccessLevel,
  CheckTarget,
  type Connection,
  ConnectionEnv,
  type ConnectionTestResult,
  ConnectionType,
  type CreateConnection,
  connectionConfigSchemas,
  ErrorCode,
  HealthStatus,
  SECRET_REQUIRED,
  type UpdateConnection,
} from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { ApiError, validationFailed } from '../common/errors';
import { mergeConfig } from '../common/merge-config';
import { connections } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { KEYCHAIN, type Keychain } from '../keychain/keychain';
import { ConnectionServers, McpServersService } from '../mcp/mcp-servers.service';
import { CONNECTION_TESTER, type ConnectionTester } from './connection-tester';
import { hasServer, type Launch, launchFor, supportsReadOnly } from './launch';

type Row = typeof connections.$inferSelect;

/** The Connection's own secret. The launch env vars the server reads sit under the MCP server's Keychain key. */
const secretKey = (id: string) => `connection:${id}`;

@Injectable()
export class ConnectionsService implements OnModuleInit {
  private readonly logger = new Logger('connections');

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(KEYCHAIN) private readonly keychain: Keychain,
    @Inject(CONNECTION_TESTER) private readonly tester: ConnectionTester,
    @Inject(McpServersService) private readonly mcp: McpServersService,
    @Inject(ConnectionServers) private readonly servers: ConnectionServers,
  ) {}

  onModuleInit(): void {
    this.servers.use(() => this.rows().map((row) => row.name));
  }

  async list(): Promise<{ data: Connection[]; meta: { next_cursor: null } }> {
    return { data: await Promise.all(this.rows().map((row) => this.view(row))), meta: { next_cursor: null } };
  }

  async get(id: string): Promise<Connection> {
    return this.view(this.row(id));
  }

  async create(body: CreateConnection): Promise<Connection> {
    const config = this.validConfig(body.type, body.config);
    if (SECRET_REQUIRED.includes(body.type) && !body.secret) throw validationFailed('invalid body: secret');
    if (this.rows().some((row) => row.name === body.name) || (await this.mcp.exists(body.name))) {
      throw new ApiError(409, ErrorCode.Duplicate, `${body.name} is already used`);
    }
    const access = this.accessFor(body.type, body.access);
    const id = crypto.randomUUID();
    try {
      if (body.secret) await this.keychain.set(secretKey(id), body.secret);
      await this.register(body.name, { type: body.type, config, secret: body.secret ?? null, access });
    } catch (error) {
      await this.keychain.delete(secretKey(id));
      throw error;
    }
    this.store.write((tx) => {
      tx.insert(connections)
        .values({ id, name: body.name, type: body.type, env: body.env, access, config: JSON.stringify(config) })
        .run();
    });
    void this.check(id).catch((error) => this.logger.warn(`checking ${body.name} failed: ${String(error)}`));
    return this.get(id);
  }

  async update(id: string, body: UpdateConnection): Promise<Connection> {
    const row = this.row(id);
    const config =
      body.config === undefined
        ? (JSON.parse(row.config) as Record<string, unknown>)
        : this.validConfig(row.type, mergeConfig(JSON.parse(row.config) as Record<string, unknown>, body.config));
    const access = body.access ?? row.access;
    if (body.access !== undefined) this.accessFor(row.type, body.access);
    const name = body.name ?? row.name;
    if (name !== row.name && (this.rows().some((other) => other.name === name) || (await this.mcp.exists(name)))) {
      throw new ApiError(409, ErrorCode.Duplicate, `${name} is already used`);
    }
    const secret = body.secret ?? (await this.keychain.get(secretKey(id)));
    const changed = [body.name, body.access, body.config, body.secret].some((value) => value !== undefined);
    if (changed) {
      if (name !== row.name) await this.mcp.unregisterConnectionServer(row.name);
      await this.register(name, { type: row.type, config, secret, access });
      if (body.secret) await this.keychain.set(secretKey(id), body.secret);
    }
    this.store.write((tx) => {
      tx.update(connections)
        .set({ name, env: body.env ?? row.env, access, config: JSON.stringify(config) })
        .where(eq(connections.id, id))
        .run();
    });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const row = this.row(id);
    await this.mcp.unregisterConnectionServer(row.name);
    await this.keychain.delete(secretKey(id));
    this.store.write((tx) => {
      tx.delete(connections).where(eq(connections.id, id)).run();
    });
  }

  /** Starts the server with the given secret held in memory and runs one read. Nothing is stored. */
  async test(
    type: ConnectionType,
    rawConfig: Record<string, unknown>,
    secret: string | null,
  ): Promise<ConnectionTestResult> {
    const config = this.validConfig(type, rawConfig);
    const launch = launchFor({ type, config, secret, access: AccessLevel.Read });
    if (!launch) return { status: HealthStatus.Fail, latency_ms: null, detail: `no MCP server for ${type}` };
    return this.tester.run(type, launch);
  }

  /** The same test with the stored secret; records the result. */
  async check(id: string) {
    const row = this.row(id);
    const secret = await this.keychain.get(secretKey(id));
    const result = await this.test(row.type, JSON.parse(row.config) as Record<string, unknown>, secret);
    const at = new Date().toISOString();
    this.store.write((tx, emit) => {
      tx.update(connections)
        .set({ status: result.status, statusDetail: result.detail, latencyMs: result.latency_ms, lastCheckedAt: at })
        .where(eq(connections.id, id))
        .run();
      emit('connection.checked', {
        target: CheckTarget.Connection,
        id,
        status: result.status,
        detail: result.detail,
        latency_ms: result.latency_ms,
      });
    });
    return { status: result.status, status_detail: result.detail, latency_ms: result.latency_ms, last_checked_at: at };
  }

  /** A Connection with Access Level `none` is not registered, so no agent session can reach it. */
  private async register(
    name: string,
    input: { type: ConnectionType; config: Record<string, unknown>; secret: string | null; access: AccessLevel },
  ): Promise<void> {
    const launch: Launch | null = input.access === AccessLevel.None ? null : launchFor(input);
    if (launch === null) await this.mcp.unregisterConnectionServer(name);
    else await this.mcp.registerConnectionServer(name, launch.target, launch.env);
  }

  private accessFor(type: ConnectionType, requested: AccessLevel | undefined): AccessLevel {
    const access = requested ?? (supportsReadOnly(type) ? AccessLevel.Read : AccessLevel.None);
    if (access === AccessLevel.Read && !supportsReadOnly(type)) {
      throw validationFailed(`invalid body: access (no read-only server for ${type})`);
    }
    if (access !== AccessLevel.None && !hasServer(type)) {
      throw validationFailed(`invalid body: access (no MCP server for ${type} yet)`);
    }
    return access;
  }

  private validConfig(type: ConnectionType, config: Record<string, unknown>): Record<string, unknown> {
    const parsed = connectionConfigSchemas[type].safeParse(config);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'config'))];
      throw validationFailed(`invalid config: ${fields.join(', ')}`);
    }
    return parsed.data;
  }

  private async view(row: Row): Promise<Connection> {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      env: row.env,
      access: row.access,
      config: JSON.parse(row.config) as Record<string, unknown>,
      status: row.status,
      status_detail: row.statusDetail,
      latency_ms: row.latencyMs,
      last_checked_at: row.lastCheckedAt,
      created_at: row.createdAt,
      is_prod: row.env === ConnectionEnv.Prod,
      secret_stored: (await this.keychain.get(secretKey(row.id))) !== null,
    };
  }

  private rows(): Row[] {
    return this.store.db.select().from(connections).orderBy(connections.createdAt).all();
  }

  private row(id: string): Row {
    const row = this.store.db.select().from(connections).where(eq(connections.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such Connection');
    return row;
  }
}
