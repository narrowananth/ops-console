import { Inject, Injectable } from '@nestjs/common';
import { createMcpServerSchema, ErrorCode, type SecretRequest, SessionKind } from '@ops-console/shared';
import { type AnonymousCall, type AnonymousTools, type ToolPlan } from '../agent/anonymous-tools';
import { AgentRuntime } from '../agent/runtime';
import { SessionsService } from '../agent/sessions.service';
import { ApiError, parseInput, validationFailed } from '../common/errors';
import { ConnectionsService } from '../connections/connections.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { STORE, type Store } from '../db/store';
import { McpServersService } from '../mcp/mcp-servers.service';
import { fetchUrl, LOCAL_KEYCHAIN, type LocalKeychain, listLocalDir, readLocalFile } from './local-sources';
import { PLACEHOLDER } from './secret-masking';

type Pending = { sessionId: string; label: string; resolve(placeholder: string): void; reject(error: Error): void };

const where = (config: Record<string, unknown>) =>
  `${String(config.host ?? '')}${config.port ? `:${String(config.port)}` : ''}${config.database ? `/${String(config.database)}` : ''}`;

/**
 * The setup tools of an Anonymous Session, in the daemon. Secrets the tools read or the operator types are kept here in
 * memory, per Session, and the agent gets `{{secret:<n>}}` placeholders: the value is swapped back in only inside a
 * call the console runs (a test, a save, a header), and the Keychain gets it when a Connection is saved.
 */
@Injectable()
export class AnonymousToolsService implements AnonymousTools {
  /** Placeholder `{{secret:<n>}}` is `secrets.get(session)[n - 1]`. Daemon memory only. */
  private readonly secrets = new Map<string, string[]>();
  private readonly requests = new Map<string, Pending>();

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(ConnectionsService) private readonly connections: ConnectionsService,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(McpServersService) private readonly mcp: McpServersService,
    @Inject(LOCAL_KEYCHAIN) private readonly keychain: LocalKeychain,
    @Inject(AgentRuntime) runtime: AgentRuntime,
  ) {
    runtime.setAnonymousTools(this);
    sessions.onRemoved((id) => this.forget(id));
  }

  /** An Anonymous Session no Alert made: a Verification or Fix keeps working in its own clone. */
  offers(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session.kind === SessionKind.Anonymous && session.alertId === null;
  }

  plan(sessionId: string, call: AnonymousCall): ToolPlan {
    switch (call.tool) {
      case 'test_connection': {
        this.resolve(sessionId, call.input.secret);
        const at = where(call.input.config);
        return {
          target: `${call.input.type} ${at}`,
          command: `test_connection ${call.input.type} ${at}`,
          approval: `Test a ${call.input.type} Connection to ${at}: the console starts its database server with the secret you give it and runs one read. Nothing is stored.`,
        };
      }
      case 'save_connection': {
        this.resolve(sessionId, call.input.secret);
        const { name, env, type, access, config } = call.input;
        const at = where(config);
        return {
          target: `connection ${name}`,
          command: `save_connection ${name} ${type} ${at} ${env}`,
          approval: `Save a ${env.toUpperCase()} ${type} Connection "${name}" (${at}${access ? `, ${access} access` : ''}), with its secret in the Keychain. A PROD Connection is read-only.`,
        };
      }
      case 'connect_connector':
        return {
          target: `connector ${call.input.id}`,
          command: `connect_connector ${call.input.id}`,
          approval: `Start the sign-in of the ${call.input.id} Connector. You finish it in the browser.`,
        };
      case 'authenticate_mcp_server':
        return {
          target: `MCP Server ${call.input.name}`,
          command: `authenticate_mcp_server ${call.input.name}`,
          approval: `Start the browser sign-in of the MCP Server "${call.input.name}".`,
        };
      case 'add_mcp_server': {
        this.addMcpBody(sessionId, call.input);
        const headers = Object.keys(call.input.headers ?? {});
        return {
          target: `MCP Server ${call.input.name}`,
          command: `add_mcp_server ${call.input.name} ${call.input.url}${headers.length > 0 ? ` (headers ${headers.join(', ')})` : ''}`,
          approval: `Register the remote MCP Server "${call.input.name}" at ${call.input.url} for every account${headers.length > 0 ? `, with the headers ${headers.join(', ')}` : ''}. Claude Code keeps headers in its own config.`,
        };
      }
      case 'read_keychain_secret': {
        const { service, account } = call.input;
        return {
          target: 'Keychain',
          command: `read_keychain_secret ${service}${account ? ` ${account}` : ''}`,
          approval: `Read the saved password of "${service}"${account ? ` (account ${account})` : ''} from your Keychain. macOS asks you to allow it. The agent gets a placeholder, never the password.`,
        };
      }
      case 'list_keychain_items':
        return {
          target: 'Keychain',
          command: `list_keychain_items ${call.input.filter}`,
          approval: null,
        };
      case 'read_local_file':
        return { target: call.input.path, command: `read_local_file ${call.input.path}`, approval: null };
      case 'list_local_folder':
        return { target: call.input.path, command: `list_local_folder ${call.input.path}`, approval: null };
      case 'fetch_url':
        return { target: call.input.url, command: `fetch_url ${call.input.url}`, approval: null };
      case 'request_secret':
        return { target: 'masked field', command: `request_secret ${call.input.label}`, approval: null };
      case 'list_connections':
      case 'list_mcp_servers':
        return { target: 'console', command: call.tool, approval: null };
    }
  }

  async run(sessionId: string, call: AnonymousCall, signal: AbortSignal | undefined): Promise<unknown> {
    const keep = (value: string) => this.keep(sessionId, value);
    switch (call.tool) {
      case 'request_secret':
        return { placeholder: await this.request(sessionId, call.input.label, signal) };
      case 'test_connection':
        return this.connections.test(call.input.type, call.input.config, this.resolve(sessionId, call.input.secret));
      case 'save_connection': {
        const saved = await this.connections.create({
          ...call.input,
          secret: this.resolve(sessionId, call.input.secret) ?? undefined,
        });
        return saved;
      }
      case 'connect_connector':
        await this.connectors.connect(call.input.id);
        return { started: call.input.id };
      case 'authenticate_mcp_server':
        await this.mcp.authenticate(call.input.name);
        return { started: call.input.name };
      case 'list_connections':
        return (await this.connections.list()).data.map(({ name, type, env, access, config }) => ({
          name,
          type,
          env,
          access,
          config,
        }));
      case 'list_mcp_servers':
        return this.mcp.registeredServers();
      case 'read_local_file':
        return readLocalFile(call.input.path, keep, call.input.pick);
      case 'list_local_folder':
        return listLocalDir(call.input.path);
      case 'fetch_url':
        return fetchUrl(call.input.url, keep);
      case 'list_keychain_items':
        return this.keychain.items(call.input.filter);
      case 'read_keychain_secret': {
        const { kind = 'generic', service, account = '' } = call.input;
        const value = await this.keychain.read({ kind, service, account });
        if (value === null) throw new ApiError(404, ErrorCode.NotFound, `no Keychain item ${service}`);
        return { placeholder: `{{secret:${keep(value)}}}` };
      }
      case 'add_mcp_server': {
        const body = this.addMcpBody(sessionId, call.input);
        await this.mcp.create(body);
        return { added: body.name };
      }
    }
  }

  /** The masked fields a Session's agent waits on. */
  pending(sessionId: string): SecretRequest[] {
    return [...this.requests.entries()]
      .filter(([, request]) => request.sessionId === sessionId)
      .map(([request_id, request]) => ({ request_id, label: request.label }));
  }

  /** The operator filled the masked field: the value stays here and the agent's call gets its placeholder. */
  answer(sessionId: string, requestId: string, value: string): void {
    const request = this.requests.get(requestId);
    if (!request || request.sessionId !== sessionId)
      throw new ApiError(404, ErrorCode.NotFound, 'no such secret request');
    this.requests.delete(requestId);
    request.resolve(`{{secret:${this.keep(sessionId, value)}}}`);
    this.store.emit('secret.settled', { session_id: sessionId, request_id: requestId });
  }

  private request(sessionId: string, label: string, signal: AbortSignal | undefined): Promise<string> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.requests.set(requestId, { sessionId, label, resolve, reject });
      // A Stop on the run takes the field away: nobody waits for it.
      signal?.addEventListener('abort', () => this.cancel(requestId, 'stopped'), { once: true });
      this.store.emit('secret.requested', { session_id: sessionId, request_id: requestId, label });
    });
  }

  private cancel(requestId: string, why: string): void {
    const request = this.requests.get(requestId);
    if (!request) return;
    this.requests.delete(requestId);
    request.reject(new Error(why));
    this.store.emit('secret.settled', { session_id: request.sessionId, request_id: requestId });
  }

  private forget(sessionId: string): void {
    for (const [requestId, request] of this.requests)
      if (request.sessionId === sessionId) this.cancel(requestId, 'the Session ended');
    this.secrets.delete(sessionId);
  }

  /** Remote servers only: a stdio server is a command the daemon would run. */
  private addMcpBody(sessionId: string, input: Extract<AnonymousCall, { tool: 'add_mcp_server' }>['input']) {
    const transport = input.transport ?? 'http';
    if (transport !== 'http' && transport !== 'sse') throw validationFailed('only an http or sse MCP server by URL');
    const headers = Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([name, value]) => [name, this.resolve(sessionId, value) ?? '']),
    );
    return parseInput(
      createMcpServerSchema,
      { name: input.name, transport, target: input.url, scope: 'user', headers },
      'body',
    );
  }

  /** Swaps `{{secret:<n>}}` for the Session's secret. Only the daemon ever holds the value. */
  private resolve(sessionId: string, value: string | undefined): string | null {
    if (value === undefined) return null;
    const list = this.secrets.get(sessionId) ?? [];
    return value.replace(PLACEHOLDER, (_all, n: string) => {
      const secret = list[Number(n) - 1];
      if (secret === undefined) throw validationFailed(`unknown placeholder {{secret:${n}}}: ask with request_secret`);
      return secret;
    });
  }

  private keep(sessionId: string, value: string): number {
    const list = this.secrets.get(sessionId) ?? [];
    this.secrets.set(sessionId, list);
    const known = list.indexOf(value);
    if (known !== -1) return known + 1;
    list.push(value);
    return list.length;
  }
}
