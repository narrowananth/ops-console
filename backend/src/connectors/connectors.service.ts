import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';
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
  GOOGLE_SCOPES,
  HealthStatus,
  isGoogleConnector,
  type LogGroupPick,
  type McpServer,
} from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { bounded } from '../common/bounded';
import { ApiError, validationFailed } from '../common/errors';
import { mergeConfig } from '../common/merge-config';
import { connectors } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { GOOGLE_ENV } from '../mcp/google-bridge';
import { McpServersService } from '../mcp/mcp-servers.service';
import { cloudWatchLogsConfig, otelLogsConfig } from '../monitor/log-source-config';
import { CONNECTOR_TOOLS, type ConnectorTools, type SignInPrompt } from './connector-tools';
import { GOOGLE_AUTH, type GoogleAuth, GoogleSignInError } from './google-auth';

type Row = typeof connectors.$inferSelect;

/** A sign-in that has not let go this long after a stop is left; the process exit ends it. */
const STOP_WAIT_MS = 5_000;

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
    @Inject(GOOGLE_AUTH) private readonly google: GoogleAuth,
    @Inject(McpServersService) private readonly mcp: McpServersService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    for (const signIn of this.signIns.values()) signIn.abort();
    this.mcp.abortInFlight();
    await bounded(Promise.allSettled(this.running), STOP_WAIT_MS);
  }

  async list(): Promise<{ data: Connector[]; meta: { next_cursor: null } }> {
    await this.follow();
    const rows = this.rows();
    // A Connector reached through its MCP server follows the kept readings (`follow`) and is read when opened (Check).
    const stale = rows.filter(
      (row) => row.status !== HealthStatus.Off && !SERVER_ONLY.includes(row.id) && isStale(row.lastCheckedAt),
    );
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
    const before = JSON.parse(row.config) as Record<string, unknown>;
    const merged = mergeConfig(before, changes);
    const parsed = connectorConfigSchemas[id].safeParse(merged);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'config'))];
      throw validationFailed(`invalid config: ${fields.join(', ')}`);
    }
    if (id === ConnectorId.CloudWatchLogs) {
      const next = parsed.data as CloudWatchConfig;
      assertUniqueServices(next.log_groups);
    }
    this.store.write((tx) => {
      tx.update(connectors)
        .set({ config: JSON.stringify(parsed.data) })
        .where(eq(connectors.id, id))
        .run();
    });
    if (id === ConnectorId.CloudWatchLogs && row.status === HealthStatus.Ok) {
      const next = parsed.data as CloudWatchConfig;
      if (next.profile !== before.profile || next.region !== before.region) {
        await this.registerCloudWatch(next);
        await this.check(id);
      }
    }
    return this.get(id);
  }

  /** The log groups the profile sees in the region, for the picker; the Connector's own when none are given. */
  async cloudWatchLogGroups(chosen: { profile?: string; region?: string }): Promise<string[]> {
    const stored = cloudWatchLogsConfig(this.store.db);
    const profile = chosen.profile?.trim() || stored.profile;
    const region = chosen.region?.trim() || stored.region;
    if (profile === '' || region === '') throw validationFailed('an AWS profile and a region are required');
    this.assertAwsNames(profile, region);
    await this.requireTools(['aws']);
    return this.tools.awsLogGroups(profile, region);
  }

  /**
   * Starts the provider's own browser sign-in and answers at once. `sign_in` holds what the browser step needs until it
   * ends; `connection.checked` reports each change and the result.
   */
  async connect(id: ConnectorId, input: ConnectInput = {}): Promise<void> {
    // The Log folder has no sign-in: choosing it connects, or is refused, before this answers.
    if (id === ConnectorId.OtelLogs) return this.chooseFolder(input.folder);
    // A profile that is already signed in connects before this answers; any other waits on its sign-in below.
    if (id === ConnectorId.CloudWatchLogs && (await this.prepareCloudWatch(input))) return;
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
    // Dropped now, not when the stopped sign-in settles: a Connect on another Google Connector must not be refused for it.
    this.signIns.delete(id);
    this.prompts.delete(id);
    const server = CONNECTOR_SERVERS[id];
    // Google takes its access back first; a Google that does not answer does not keep the operator from disconnecting.
    // Google ties the grant to the account and the client, so while another Google Connector uses the same account,
    // revoking would sign that one out too.
    if (server && isGoogleConnector(id) && !this.accountInUseElsewhere(id)) {
      const token = (await this.mcp.envOf(server.name))[GOOGLE_ENV.refreshToken];
      if (token) await this.google.revoke(token).catch(() => {});
    }
    if (server && !this.sharedServer(id, server.name)) {
      const found = await this.mcp.find(server.name);
      // A read of the list that no longer holds the server means it is already gone: Disconnect goes on.
      if (found?.registered) await this.mcp.remove(server.name).catch(ignoreMissing);
    }
    this.store.write((tx) => {
      tx.update(connectors)
        .set({ status: HealthStatus.Off, statusDetail: null, accountLabel: null, login: null })
        .where(eq(connectors.id, id))
        .run();
    });
    return this.get(id);
  }

  /** Throws `tool_missing` for the first of `commands` not on the PATH. The console installs neither. */
  private async requireTools(commands: ('aws' | 'uvx')[]): Promise<void> {
    for (const command of commands) {
      if (!(await this.tools.installed(command))) {
        throw new ApiError(422, ErrorCode.ToolMissing, missingToolMessage(command));
      }
    }
  }

  private assertAwsNames(profile: string, region: string): void {
    const parsed = connectorConfigSchemas[ConnectorId.CloudWatchLogs]
      .pick({ profile: true, region: true })
      .safeParse({ profile, region });
    if (!parsed.success) throw validationFailed('invalid AWS profile or region');
  }

  /** Throws `log_group_not_found` naming the first picked group the profile does not see. */
  private async assertGroupsExist(profile: string, region: string, picked: LogGroupPick[]): Promise<void> {
    if (picked.length === 0) return;
    const have = new Set(await this.tools.awsLogGroups(profile, region));
    const gone = picked.find((group) => !have.has(group.name));
    if (gone) throw new ApiError(422, ErrorCode.LogGroupNotFound, `Log group ${gone.name} was not found in ${region}`);
  }

  /** Registers AWS's CloudWatch server with the profile and region in its environment; again when they changed. */
  private async registerCloudWatch({ profile, region }: { profile: string; region: string }): Promise<void> {
    const base = CONNECTOR_SERVERS[ConnectorId.CloudWatchLogs] as McpSpec;
    const target = `env AWS_PROFILE=${profile} AWS_REGION=${region} FASTMCP_LOG_LEVEL=ERROR ${base.target}`;
    const found = await this.mcp.find(base.name);
    // A server of this name that is not the AWS Labs one is the operator's own: never replaced.
    if (found?.registered && !found.target.endsWith(base.target)) {
      throw new ApiError(409, ErrorCode.Duplicate, `${base.name} is already used`);
    }
    if (found?.registered && found.target !== target) {
      await this.mcp.remove(base.name).catch(ignoreMissing);
      await this.mcp.settled();
    }
    await this.mcp.ensureRegistered({ ...base, target });
  }

  /**
   * Stores the pane's profile, region and groups after the checks that need no sign-in, and connects at once when the
   * profile is already signed in. True when connected; false leaves the sign-in to Connect.
   */
  private async prepareCloudWatch(input: ConnectInput): Promise<boolean> {
    await this.requireTools(['aws', 'uvx']);
    const stored = cloudWatchLogsConfig(this.store.db);
    const profile = input.profile?.trim() || stored.profile;
    const region = input.region?.trim() || stored.region;
    if (profile === '') throw validationFailed('an AWS profile is required');
    if (region === '') throw validationFailed('an AWS region is required');
    this.assertAwsNames(profile, region);
    const picked = input.log_groups ?? stored.log_groups;
    assertUniqueServices(picked);
    const signedIn = await this.tools.awsSignedIn(profile);
    if (signedIn) await this.assertGroupsExist(profile, region, picked);
    await this.update(ConnectorId.CloudWatchLogs, { profile, region, log_groups: picked });
    if (!signedIn) return false;
    await this.registerCloudWatch({ profile, region });
    this.record(ConnectorId.CloudWatchLogs, cloudWatchReading(profile));
    return true;
  }

  /** Connects the Log folder: `folder`, or the one kept from before. Refused with `folder_not_found`, nothing stored. */
  private async chooseFolder(chosen: string | undefined): Promise<void> {
    const folder = (chosen ?? otelLogsConfig(this.store.db).folder).trim();
    if (folder === '') throw validationFailed('a Log folder is required');
    if (!path.isAbsolute(folder)) throw validationFailed('the Log folder must be an absolute path');
    const reading = await folderReading(folder);
    if (reading.status !== HealthStatus.Ok) {
      throw new ApiError(422, ErrorCode.FolderNotFound, reading.detail ?? 'Folder not found');
    }
    await this.update(ConnectorId.OtelLogs, { folder });
    this.record(ConnectorId.OtelLogs, reading);
  }

  private accountInUseElsewhere(id: ConnectorId): boolean {
    const login = this.row(id).login;
    return (
      login !== null &&
      this.rows().some(
        (row) => row.id !== id && isGoogleConnector(row.id) && row.status !== HealthStatus.Off && row.login === login,
      )
    );
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
        const known = await this.tools.gitlabUser(host);
        if (known !== null) {
          // The read that decided to skip the sign-in already has the login.
          return this.landed(id, signal, {
            status: HealthStatus.Ok,
            detail: null,
            accountLabel: config.host ?? null,
            login: known,
          });
        }
        await this.tools.gitlabLogin(host, signal, onPrompt);
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
        const known = await this.tools.bitbucketUser();
        if (known !== null) {
          return this.landed(id, signal, {
            status: HealthStatus.Ok,
            detail: null,
            accountLabel: config.workspace || known,
            login: known,
          });
        }
        await this.tools.bitbucketLogin(signal, onPrompt);
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
        const known = await this.tools.slashdocsUser();
        if (known !== null) {
          return this.landed(id, signal, {
            status: HealthStatus.Ok,
            detail: null,
            accountLabel: config.server || null,
            login: known.email,
          });
        }
        await this.tools.slashdocsLogin(config.server?.trim() || null, signal, onPrompt);
        break;
      }
      case ConnectorId.Shopify: {
        const server = CONNECTOR_SERVERS[id] as McpSpec;
        await this.mcp.ensureRegistered(server);
        const found = await this.mcp.checkOne(server.name);
        if (!signal.aborted) this.record(id, serverReading(found, config));
        return;
      }
      case ConnectorId.CloudWatchLogs: {
        const settings = cloudWatchLogsConfig(this.store.db);
        // Only an Identity Center profile has a browser sign-in; any other one is signed in with `aws login`.
        if (!(await this.tools.awsIsSso(settings.profile)))
          throw new ApiError(409, ErrorCode.InvalidState, signedOutDetail(settings.profile));
        await this.tools.awsLogin(settings.profile, signal, onPrompt);
        if (signal.aborted) return;
        if (!(await this.tools.awsSignedIn(settings.profile))) {
          throw new ApiError(409, ErrorCode.InvalidState, 'AWS did not finish signing in');
        }
        await this.assertGroupsExist(settings.profile, settings.region, settings.log_groups);
        if (signal.aborted) return;
        await this.registerCloudWatch(settings);
        return this.landed(id, signal, cloudWatchReading(settings.profile));
      }
      case ConnectorId.GoogleDocs:
      case ConnectorId.GoogleSheets:
      case ConnectorId.GoogleDrive: {
        const client = this.google.client();
        if (client === null) {
          throw new ApiError(409, ErrorCode.InvalidState, 'Google sign-in is not set up in this build');
        }
        // Google's account chooser and consent screen, in the operator's browser; the code comes back to this Mac.
        const signedIn = await this.google
          .signIn(GOOGLE_SCOPES[id] as string[], signal, (url) => {
            onPrompt({ code: null, url });
            void this.tools.openPage(url).catch(() => {
              // The page link stays in the pane.
            });
          })
          .catch((error) => {
            if (!(error instanceof GoogleSignInError)) throw error;
            throw new ApiError(
              409,
              ErrorCode.InvalidState,
              error.kind === 'timeout' ? `${CONNECTOR_NAMES[id]} ${error.message}` : error.message,
            );
          });
        if (signal.aborted) return;
        // The token reaches the bridge through the Keychain and the launcher, never a Claude config.
        await this.mcp.ensureRegistered(CONNECTOR_SERVERS[id] as McpSpec, {
          [GOOGLE_ENV.clientId]: client.clientId,
          [GOOGLE_ENV.clientSecret]: client.clientSecret,
          [GOOGLE_ENV.refreshToken]: signedIn.refreshToken,
        });
        return this.landed(id, signal, {
          status: HealthStatus.Ok,
          detail: null,
          accountLabel: signedIn.email,
          login: signedIn.email,
        });
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
   * The provider's sign-in finished: the drawer stops waiting and the check records the account at once (or `proved`
   * does, when the CLI had answered before). Steps after it, such as registering the MCP server, run on; one that
   * fails records why.
   */
  private async landed(id: ConnectorId, signal: AbortSignal, proved?: Reading): Promise<void> {
    if (signal.aborted) return;
    this.prompts.delete(id);
    // A sign-in that was skipped because the CLI already answered has the account in hand: no second read.
    if (proved) this.record(id, proved);
    else await this.check(id);
  }

  /** Installs each command not on the PATH from Homebrew; its formula has the command's name. */
  private async installMissing(commands: string[]): Promise<void> {
    const present = await Promise.all(commands.map((command) => this.tools.installed(command)));
    const missing = commands.filter((_, index) => !present[index]);
    if (missing.length === 0) return;
    if (!(await this.tools.installed('brew'))) {
      throw new ApiError(
        409,
        ErrorCode.InvalidState,
        `${missing[0]} is not installed and Homebrew is missing: install Homebrew from brew.sh, then Connect again`,
      );
    }
    await this.tools.install(missing);
  }

  /** A sign-in that fails or is cancelled leaves `auth` with the reason (Behavior 6). */
  private fail(id: ConnectorId, error: unknown): void {
    this.logger.warn(`${id} sign-in did not finish`);
    const detail = error instanceof ApiError ? error.message : 'the sign-in did not finish';
    // A picked group that is gone, or a server name already used, is a Connector that is down, not one that needs signing in.
    const down =
      error instanceof ApiError && (error.code === ErrorCode.LogGroupNotFound || error.code === ErrorCode.Duplicate);
    this.record(id, { status: down ? HealthStatus.Fail : HealthStatus.Auth, detail, accountLabel: null, login: null });
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
      case ConnectorId.OtelLogs:
        return folderReading(config.folder ?? '');
      case ConnectorId.CloudWatchLogs: {
        const profile = config.profile ?? '';
        const down = (detail: string): Reading => ({
          status: HealthStatus.Fail,
          detail,
          accountLabel: null,
          login: null,
        });
        if (!(await this.tools.installed('aws'))) return down(missingToolMessage('aws'));
        if (profile === '') return down('No AWS profile chosen');
        if (await this.tools.awsSignedIn(profile)) return cloudWatchReading(profile);
        return signedOut(
          (await this.tools.awsIsSso(profile))
            ? `The AWS session for ${profile} has expired. Connect to sign in again.`
            : signedOutDetail(profile),
        );
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
      case ConnectorId.GoogleDocs:
      case ConnectorId.GoogleSheets:
      case ConnectorId.GoogleDrive: {
        const token = (await this.mcp.envOf((CONNECTOR_SERVERS[id] as McpSpec).name))[GOOGLE_ENV.refreshToken];
        if (!token) return signedOut(`${CONNECTOR_NAMES[id]} needs signing in`);
        // Only a token Google refuses reads `auth`; a Google that does not answer reads `fail` (the caller's catch).
        return (await this.google.check(token))
          ? { status: HealthStatus.Ok, detail: null, accountLabel: row.accountLabel, login: row.login }
          : signedOut(`${CONNECTOR_NAMES[id]} needs signing in again`);
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
    // The kept readings only: a list read starts no Probe.
    const servers = await this.mcp.list({ probe: false }).catch(() => null);
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
export const SERVER_ONLY: ConnectorId[] = [
  ConnectorId.Jira,
  ConnectorId.Slack,
  ConnectorId.Sentry,
  ConnectorId.Shopify,
];

type McpSpec = NonNullable<(typeof CONNECTOR_SERVERS)[ConnectorId]>;

function isStale(lastCheckedAt: string | null): boolean {
  return lastCheckedAt === null || Date.now() - Date.parse(lastCheckedAt) > RECHECK_AFTER_MS;
}

/** A Log folder reads connected when it is a folder the daemon can list; an empty one is fine. */
async function folderReading(folder: string): Promise<Reading> {
  const down = (detail: string): Reading => ({ status: HealthStatus.Fail, detail, accountLabel: null, login: null });
  if (folder === '') return down('No Log folder chosen');
  const found = await stat(folder).catch(() => null);
  if (found === null || !found.isDirectory()) return down('Folder not found');
  const listed = await opendir(folder).then(
    (handle) => handle.close().then(() => true),
    () => false,
  );
  return listed
    ? { status: HealthStatus.Ok, detail: null, accountLabel: folder, login: null }
    : down('Folder not readable');
}

type CloudWatchConfig = ReturnType<typeof cloudWatchLogsConfig>;

/** What the pane's Connect sends. The Log folder takes `folder`; CloudWatch logs takes the other three. */
export type ConnectInput = { folder?: string; profile?: string; region?: string; log_groups?: LogGroupPick[] };

const INSTALL: Record<'aws' | 'uvx', string> = {
  aws: 'the AWS CLI with `brew install awscli`',
  uvx: 'uv with `brew install uv`',
};

function missingToolMessage(command: 'aws' | 'uvx'): string {
  return `${command} is not installed: install ${INSTALL[command]}, then Connect again`;
}

function signedOutDetail(profile: string): string {
  return `AWS profile ${profile} is signed out. Run \`aws login --profile ${profile}\`, then Connect again.`;
}

const cloudWatchReading = (profile: string): Reading => ({
  status: HealthStatus.Ok,
  detail: null,
  accountLabel: profile,
  login: null,
});

/** Two picked groups with one Service name and env would be one Service. */
function assertUniqueServices(picked: LogGroupPick[]): void {
  const seen = new Set<string>();
  for (const { service, env } of picked) {
    const key = JSON.stringify([service, env]);
    if (seen.has(key)) {
      throw new ApiError(422, ErrorCode.DuplicateService, `Two log groups are the Service ${service} in ${env}`);
    }
    seen.add(key);
  }
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

function ignoreMissing(error: unknown): void {
  if (!(error instanceof ApiError && error.status === 404)) throw error;
}
