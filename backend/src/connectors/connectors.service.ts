import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  type AwsProfile,
  CheckTarget,
  CONNECTOR_NAMES,
  CONNECTOR_ORDER,
  CONNECTOR_SERVERS,
  CONNECTOR_VIA,
  type ConnectBody,
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
  NEW_RELIC_MCP_URLS,
  NEW_RELIC_REGIONS,
  type NewRelicRoute,
  type Pickable,
} from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { bounded } from '../common/bounded';
import { ApiError, validationFailed } from '../common/errors';
import { mergeConfig } from '../common/merge-config';
import { StartupRecovery } from '../common/recovery';
import { connectors } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { KEYCHAIN, type Keychain } from '../keychain/keychain';
import { GOOGLE_ENV } from '../mcp/google-bridge';
import { McpServersService } from '../mcp/mcp-servers.service';
import { cloudWatchLogsConfig, lokiLogsConfig, newRelicLogsConfig, otelLogsConfig } from '../monitor/log-source-config';
import { FOLDER_PICKER, type FolderPicker } from '../repos/folder-picker';
import { CONNECTOR_TOOLS, type ConnectorTools, type SignInPrompt } from './connector-tools';
import { GOOGLE_AUTH, type GoogleAuth, GoogleSignInError } from './google-auth';
import { LOKI_OAUTH_KEY } from './grafana-auth';
import {
  HostedAuthError,
  HostedFailed,
  HostedRateLimited,
  HostedUnreachable,
  HostedUnreadable,
  readFailure,
} from './hosted-mcp';
import { HostedServers } from './hosted-servers';
import { NEW_RELIC_KEY } from './new-relic-api';
import { NEW_RELIC_SERVER } from './new-relic-mcp';

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
  /** Connectors signed in that wait on the operator's choice of a data source or an account. */
  private readonly picks = new Map<ConnectorId, 'data source' | 'account'>();
  private stopping = false;

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(CONNECTOR_TOOLS) private readonly tools: ConnectorTools,
    @Inject(GOOGLE_AUTH) private readonly google: GoogleAuth,
    @Inject(McpServersService) private readonly mcp: McpServersService,
    @Inject(KEYCHAIN) private readonly keychain: Keychain,
    @Inject(HostedServers) private readonly hosted: HostedServers,
    @Inject(FOLDER_PICKER) private readonly picker: FolderPicker,
    @Inject(StartupRecovery) recovery: StartupRecovery,
  ) {
    recovery.register('remove retired log source Keychain items', () => this.dropRetiredKeys());
  }

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
    // A User API key replaces any sign-in waiting or held, and finishes before this answers.
    if (id === ConnectorId.NewRelicLogs && input.api_key !== undefined)
      return this.connectWithKey(input.api_key, input);
    // A pick made while the key route is in use finishes with the stored key.
    if (id === ConnectorId.NewRelicLogs && input.account_id && newRelicLogsConfig(this.store.db).route === 'key') {
      return this.pickWithKey(input);
    }
    // A second Connect during the wait of a log source's sign-in changes nothing.
    if (LOG_SIGN_INS.includes(id) && this.signIns.has(id)) return;
    if (id === ConnectorId.LokiLogs || id === ConnectorId.NewRelicLogs) await this.prepareHosted(id, input);
    // A profile that is already signed in connects before this answers; any other waits on its sign-in below.
    if (id === ConnectorId.CloudWatchLogs && (await this.prepareCloudWatch(input))) return;
    this.signIns.get(id)?.abort();
    const abort = new AbortController();
    this.signIns.set(id, abort);
    this.prompt(id, { code: null, url: null });
    const run = this.signIn(id, abort.signal, input)
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
    // The console's own Grafana sign-in leaves with it; New Relic's belongs to Claude Code and goes with the server.
    if (id === ConnectorId.LokiLogs) await this.keychain.delete(LOKI_OAUTH_KEY);
    // The New Relic User API key leaves with it, and the next Connect starts on the MCP route again.
    if (id === ConnectorId.NewRelicLogs) {
      await this.keychain.delete(NEW_RELIC_KEY);
      await this.update(id, { route: 'mcp' });
    }
    this.picks.delete(id);
    this.store.write((tx) => {
      tx.update(connectors)
        .set({ status: HealthStatus.Off, statusDetail: null, accountLabel: null, login: null })
        .where(eq(connectors.id, id))
        .run();
    });
    return this.get(id);
  }

  /** Throws `tool_missing` for the first of `commands` not on the PATH. The console installs neither. */
  private async requireTools(commands: (keyof typeof INSTALL)[]): Promise<void> {
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
    // With no profile on this Mac, the sign-in creates `default`.
    const profile = input.profile?.trim() || stored.profile || 'default';
    const region =
      input.region?.trim() ||
      stored.region ||
      (await this.tools.awsProfiles()).find((found) => found.name === profile)?.region ||
      '';
    if (region === '') throw validationFailed('an AWS region is required');
    this.assertAwsNames(profile, region);
    const picked = input.log_groups ?? stored.log_groups;
    assertUniqueServices(picked);
    const signedIn = await this.tools.awsSignedIn(profile);
    if (signedIn) await this.assertGroupsExist(profile, region, picked);
    else if (!(await this.tools.awsIsSso(profile))) await this.assertLoginCli();
    await this.update(ConnectorId.CloudWatchLogs, { profile, region, log_groups: picked });
    if (!signedIn) return false;
    await this.registerCloudWatch({ profile, region });
    this.record(ConnectorId.CloudWatchLogs, cloudWatchReading(profile));
    return true;
  }

  /**
   * Loki and New Relic: stores the Region, and refuses what could not finish. A pick needs the sign-in it chooses from,
   * and a sign-in that waits on a choice is answered with `pick_required` until one comes.
   */
  private async prepareHosted(id: ConnectorId.LokiLogs | ConnectorId.NewRelicLogs, input: ConnectInput): Promise<void> {
    if (id === ConnectorId.NewRelicLogs && input.region !== undefined) {
      await this.update(id, { region: this.assertRegion(input.region) });
    }
    const pick = id === ConnectorId.LokiLogs ? input.datasource_uid : input.account_id;
    if (pick === undefined || pick === '') {
      const waiting = this.picks.get(id);
      if (waiting) throw new ApiError(409, ErrorCode.PickRequired, `Choose a ${waiting} to finish connecting`);
      return;
    }
    // The pick is checked against what the sign-in reads now, before Connect answers.
    const options = id === ConnectorId.LokiLogs ? await this.lokiDatasources() : await this.newRelicAccountList();
    if (!options.some((option) => option.id === pick)) {
      throw invalidConfig(
        `${pick} is not a ${id === ConnectorId.LokiLogs ? 'data source' : 'account'} this sign-in can read`,
      );
    }
  }

  /** The New Relic Region asked for, or undefined when none; 422 for any other value. */
  private assertRegion(region: string | undefined): (typeof NEW_RELIC_REGIONS)[number] | undefined {
    if (region === undefined) return undefined;
    const found = NEW_RELIC_REGIONS.find((one) => one === region);
    if (found === undefined) throw invalidConfig(`region must be one of ${NEW_RELIC_REGIONS.join(', ')}`);
    return found;
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

  private async signIn(id: ConnectorId, signal: AbortSignal, input: ConnectInput): Promise<void> {
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
        // An Identity Center profile signs in with `aws sso login`; any other with `aws login`.
        const kind = (await this.tools.awsIsSso(settings.profile)) ? 'sso' : 'console';
        await this.tools.awsLogin(settings.profile, settings.region, kind, signal, onPrompt);
        if (signal.aborted) return;
        if (!(await this.tools.awsSignedIn(settings.profile))) {
          throw new ApiError(409, ErrorCode.InvalidState, 'AWS did not finish signing in');
        }
        await this.assertGroupsExist(settings.profile, settings.region, settings.log_groups);
        if (signal.aborted) return;
        await this.registerCloudWatch(settings);
        return this.landed(id, signal, cloudWatchReading(settings.profile));
      }
      case ConnectorId.LokiLogs:
        return this.signInLoki(signal, onPrompt, input);
      case ConnectorId.NewRelicLogs:
        return this.signInNewRelic(signal, input);
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

  /** Grafana's sign-in for the console, then the data source the Connector reads, then the stack's server for the agent. */
  private async signInLoki(
    signal: AbortSignal,
    onPrompt: (prompt: SignInPrompt) => void,
    input: ConnectInput,
  ): Promise<void> {
    const id = ConnectorId.LokiLogs;
    const asked = input.datasource_uid || undefined;
    // A pick is made with the sign-in already held; any other Connect signs in again.
    if (asked === undefined || !(await this.hosted.grafanaSignIn.signedIn())) {
      await this.hosted.grafanaSignIn.signIn(signal, (url) => {
        onPrompt({ code: null, url });
        void this.tools.openPage(url).catch(() => {
          // The page link stays in the pane.
        });
      });
    }
    if (signal.aborted) return;
    const server = CONNECTOR_SERVERS[id] as McpSpec;
    const added = await this.mcp.ensureRegistered(server);
    const sources = await this.lokiSources().catch((error) => {
      throw readFailure(error, 'Grafana');
    });
    if (sources.length === 0) {
      this.picks.delete(id);
      return this.landed(id, signal, {
        status: HealthStatus.Auth,
        detail: 'This Grafana stack has no Loki data source. Reconnect with a stack that has one.',
        accountLabel: null,
        login: null,
      });
    }
    const chosen = this.choose('data source', sources, lokiLogsConfig(this.store.db).datasource_uid, asked);
    if (chosen === null) return this.landedPick(id, signal, 'data source');
    await this.update(id, { datasource_uid: chosen.id });
    this.picks.delete(id);
    await this.landed(id, signal, { status: HealthStatus.Ok, detail: null, accountLabel: chosen.name, login: null });
    // Grafana's server for the agent signs in on its own, usually in one click; the Connector reads connected without it.
    await this.mcp.authenticateAndCheck(server.name, { signal, added }).catch((error) => {
      this.logger.warn(`the agent's sign-in to ${server.name} did not finish: ${String(error)}`);
    });
  }

  /** New Relic's server through Claude Code's sign-in, then the account the Connector reads. */
  private async signInNewRelic(signal: AbortSignal, input: ConnectInput): Promise<void> {
    const id = ConnectorId.NewRelicLogs;
    const { region, account_id: stored } = newRelicLogsConfig(this.store.db);
    const server = { ...(CONNECTOR_SERVERS[id] as McpSpec), target: NEW_RELIC_MCP_URLS[region] };
    const found = await this.mcp.find(server.name);
    // A server registered for another Region is registered again for this one.
    if (found?.registered && found.target !== server.target) {
      await this.mcp.remove(server.name).catch(ignoreMissing);
      await this.mcp.settled();
    }
    const added = await this.mcp.ensureRegistered(server);
    const signedIn = await this.mcp.authenticateAndCheck(server.name, { signal, added });
    if (signal.aborted) return;
    if (signedIn.status !== HealthStatus.Ok) return this.landed(id, signal, serverReading(signedIn, {}));
    const accounts = await this.newRelicAccounts('mcp', region).catch((error) => {
      if (error instanceof HostedAuthError) throw new ApiError(409, ErrorCode.InvalidState, error.message);
      throw readFailure(error, 'New Relic');
    });
    // The sign-in works: it replaces a User API key held before.
    await this.keychain.delete(NEW_RELIC_KEY);
    await this.update(id, { route: 'mcp' });
    if (accounts.length === 0) {
      this.picks.delete(id);
      return this.landed(id, signal, {
        status: HealthStatus.Auth,
        detail: 'This New Relic sign-in can read no account. Reconnect with a user that can.',
        accountLabel: null,
        login: null,
      });
    }
    const chosen = this.choose('account', accounts, stored, input.account_id || undefined);
    if (chosen === null) return this.landedPick(id, signal, 'account');
    await this.update(id, { account_id: chosen.id });
    this.picks.delete(id);
    return this.landed(id, signal, {
      status: HealthStatus.Ok,
      detail: null,
      accountLabel: accountLabelOf(chosen),
      login: null,
    });
  }

  /** The one of `options` the Connector reads: the one asked for, the only one, or the stored one still there. Null when the operator must choose. */
  private choose(
    kind: 'data source' | 'account',
    options: Pickable[],
    stored: string,
    asked: string | undefined,
  ): Pickable | null {
    if (asked !== undefined) {
      const found = options.find((option) => option.id === asked);
      if (!found) throw invalidConfig(`${asked} is not a ${kind} this sign-in can read`);
      return found;
    }
    if (options.length === 1) return options[0] ?? null;
    return options.find((option) => option.id === stored) ?? null;
  }

  /** Signed in, with several to choose from: the pane shows the picker and Connect finishes when the operator picks. */
  private landedPick(id: ConnectorId, signal: AbortSignal, kind: 'data source' | 'account'): Promise<void> {
    this.picks.set(id, kind);
    return this.landed(id, signal, {
      status: HealthStatus.Auth,
      detail: kind === 'data source' ? LOKI_PICK_DETAIL : NEW_RELIC_PICK_DETAIL,
      accountLabel: null,
      login: null,
    });
  }

  /** The Loki data sources of the stack the sign-in belongs to. Throws the hosted errors. */
  private async lokiSources(): Promise<Pickable[]> {
    const answer = await this.hosted.grafana()((tools) =>
      tools.callJson('list_datasources', { type: 'loki', limit: 100 }, datasourcesAnswer),
    );
    return answer.datasources
      .filter((source) => source.type.toLowerCase() === 'loki')
      .map(({ uid, name }) => ({ id: uid, name }));
  }

  /** The accounts the New Relic sign-in or User API key can read. Throws the hosted errors. */
  private newRelicAccounts(route: NewRelicRoute, region: (typeof NEW_RELIC_REGIONS)[number]): Promise<Pickable[]> {
    return this.hosted.newRelic(route, region)((api) => api.accounts());
  }

  /**
   * New Relic with a User API key: the key proves itself by listing accounts, then goes to the Keychain, replacing the
   * MCP server Claude Code holds, and the one account is used or the pane asks for one.
   */
  private async connectWithKey(key: string, input: ConnectInput): Promise<void> {
    const id = ConnectorId.NewRelicLogs;
    const region = this.assertRegion(input.region) ?? newRelicLogsConfig(this.store.db).region;
    const accounts = await this.hosted.newRelicAccountsOf(region, key).catch((error) => {
      if (error instanceof HostedAuthError) {
        throw invalidConfig(
          'New Relic refused the User API key. Use a User key (it starts with NRAK-) and the Region its account is in.',
        );
      }
      throw readFailure(error, 'New Relic');
    });
    await this.keychain.set(NEW_RELIC_KEY, key);
    this.signIns.get(id)?.abort();
    this.signIns.delete(id);
    this.prompts.delete(id);
    await this.update(id, { region, route: 'key' });
    const server = CONNECTOR_SERVERS[id] as McpSpec;
    if ((await this.mcp.find(server.name))?.registered) {
      await this.mcp.remove(server.name).catch(ignoreMissing);
      await this.mcp.settled();
    }
    await this.finishAccounts(accounts, input.account_id || undefined);
  }

  /** The account picked after a User API key connected: it must be one the key can read. */
  private async pickWithKey(input: ConnectInput): Promise<void> {
    const id = ConnectorId.NewRelicLogs;
    const region = this.assertRegion(input.region) ?? newRelicLogsConfig(this.store.db).region;
    const accounts = await this.newRelicAccounts('key', region).catch((error) => {
      throw pickerFailure(error, 'New Relic', 'New Relic logs');
    });
    await this.update(id, { region });
    await this.finishAccounts(accounts, input.account_id);
  }

  /** The accounts a New Relic route can read, settled: one used, several asked about, none a reason. */
  private async finishAccounts(accounts: Pickable[], asked: string | undefined): Promise<void> {
    const id = ConnectorId.NewRelicLogs;
    if (accounts.length === 0) {
      this.picks.delete(id);
      this.record(id, {
        status: HealthStatus.Auth,
        detail: 'This New Relic key can read no account. Connect with a user that can.',
        accountLabel: null,
        login: null,
      });
      return;
    }
    const chosen = this.choose('account', accounts, newRelicLogsConfig(this.store.db).account_id, asked);
    if (chosen === null) {
      this.picks.set(id, 'account');
      this.record(id, { status: HealthStatus.Auth, detail: NEW_RELIC_PICK_DETAIL, accountLabel: null, login: null });
      return;
    }
    await this.update(id, { account_id: chosen.id });
    this.picks.delete(id);
    this.record(id, { status: HealthStatus.Ok, detail: null, accountLabel: accountLabelOf(chosen), login: null });
  }

  /** For the picker: the Loki data sources of the signed-in stack; 409 `invalid_state` when the Connector is not signed in. */
  async lokiDatasources(): Promise<Pickable[]> {
    if (!(await this.hosted.grafanaSignIn.signedIn())) {
      throw new ApiError(409, ErrorCode.InvalidState, 'Loki logs is not signed in');
    }
    return this.lokiSources().catch((error) => {
      throw pickerFailure(error, 'Grafana', 'Loki logs');
    });
  }

  /** For the picker: the accounts of the New Relic sign-in; 409 `invalid_state` when it is not signed in. */
  async newRelicAccountList(): Promise<Pickable[]> {
    const { region, route } = newRelicLogsConfig(this.store.db);
    if (route === 'mcp' && !(await this.mcp.find(NEW_RELIC_SERVER))?.registered) {
      throw new ApiError(409, ErrorCode.InvalidState, 'New Relic logs is not signed in');
    }
    return this.newRelicAccounts(route, region).catch((error) => {
      throw pickerFailure(error, 'New Relic', 'New Relic logs');
    });
  }

  /** For the picker: the AWS profiles on this Mac. */
  async awsProfileList(): Promise<AwsProfile[]> {
    await this.requireTools(['aws']);
    return this.tools.awsProfiles();
  }

  /** The folder dialog for the Log folder: the one folder chosen, or null when the operator closes it. */
  async pickLogFolder(): Promise<string | null> {
    const [chosen] = await this.picker.pick({
      prompt: 'Choose the folder the Collector writes logs to',
      multiple: false,
    });
    return chosen ?? null;
  }

  /** A hosted server refused the sign-in during a read: the row reads needs auth, and the pane offers Reconnect. */
  needsSignIn(id: ConnectorId): void {
    this.record(id, {
      status: HealthStatus.Auth,
      detail: `${CONNECTOR_NAMES[id]} needs signing in again.`,
      accountLabel: null,
      login: null,
    });
  }

  /** Deletes the Keychain items of `RETIRED_KEYS`; one that is not there is left as it is. */
  private async dropRetiredKeys(): Promise<void> {
    for (const key of RETIRED_KEYS) {
      await this.keychain.delete(key).catch((error) => {
        this.logger.warn(`could not delete the Keychain item ${key}: ${String(error)}`);
      });
    }
  }

  /** The one wrong step of a CloudWatch Connect: an AWS CLI too old for `aws login`. */
  private async assertLoginCli(): Promise<void> {
    const version = await this.tools.awsVersion();
    if (version !== null && atLeast(version, AWS_LOGIN_VERSION)) return;
    throw new ApiError(
      409,
      ErrorCode.InvalidState,
      `AWS CLI ${version ?? '(version unknown)'} is too old for \`aws login\`: it needs ${AWS_LOGIN_VERSION}. Update it with \`brew upgrade awscli\`, then Connect again.`,
    );
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
    const down = (detail: string): Reading => ({ status: HealthStatus.Fail, detail, accountLabel: null, login: null });
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
      case ConnectorId.LokiLogs: {
        if (!(await this.hosted.grafanaSignIn.signedIn())) {
          // The self-hosted note stays until the operator signs in to Grafana Cloud.
          return signedOut(row.statusDetail === LOKI_SELF_HOSTED_DETAIL ? row.statusDetail : LOKI_SIGN_IN_DETAIL);
        }
        let sources: Pickable[];
        try {
          sources = await this.lokiSources();
        } catch (error) {
          return hostedReading(error, 'Grafana');
        }
        const uid = lokiLogsConfig(this.store.db).datasource_uid;
        if (uid === '') return signedOut(LOKI_PICK_DETAIL);
        const source = sources.find((found) => found.id === uid);
        return source
          ? { status: HealthStatus.Ok, detail: null, accountLabel: source.name, login: null }
          : down('The Loki data source is not in this Grafana stack any more. Reconnect to choose another.');
      }
      case ConnectorId.NewRelicLogs: {
        const { region, account_id: accountId, route } = newRelicLogsConfig(this.store.db);
        if (route === 'mcp' && !(await this.mcp.find(NEW_RELIC_SERVER))?.registered) {
          return signedOut(NEW_RELIC_SIGN_IN_DETAIL);
        }
        let accounts: Pickable[];
        try {
          accounts = await this.newRelicAccounts(route, region);
        } catch (error) {
          return hostedReading(error, 'New Relic');
        }
        if (accountId === '') return signedOut(NEW_RELIC_PICK_DETAIL);
        const account = accounts.find((found) => found.id === accountId);
        return account
          ? { status: HealthStatus.Ok, detail: null, accountLabel: accountLabelOf(account), login: null }
          : down('This sign-in cannot read the New Relic account any more. Reconnect to choose another.');
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
    // A row stored before the route existed reads with its default.
    const stored = JSON.parse(row.config) as Record<string, unknown>;
    const config = row.id === ConnectorId.NewRelicLogs ? { ...stored, route: stored.route ?? 'mcp' } : stored;
    return {
      id: row.id,
      name: CONNECTOR_NAMES[row.id],
      via: row.id === ConnectorId.NewRelicLogs && config.route === 'key' ? NEW_RELIC_API_VIA : CONNECTOR_VIA[row.id],
      status: row.status,
      status_detail: row.statusDetail,
      account_label: row.accountLabel,
      login: row.login,
      config,
      last_checked_at: row.lastCheckedAt,
      sign_in: this.prompts.get(row.id) ?? null,
      pick: pickOf(row),
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

/** What the pane's Connect sends. */
export type ConnectInput = ConnectBody;

/** The log Connectors whose Connect waits on a sign-in; a second Connect during the wait changes nothing. */
const LOG_SIGN_INS = [ConnectorId.LokiLogs, ConnectorId.NewRelicLogs, ConnectorId.CloudWatchLogs];

const LOKI_SIGN_IN_DETAIL = 'Sign in again to use Grafana Cloud.';
const LOKI_PICK_DETAIL = 'Choose a Loki data source to finish connecting.';
const NEW_RELIC_PICK_DETAIL = 'Choose a New Relic account to finish connecting.';
const LOKI_SELF_HOSTED_DETAIL = 'Loki on Grafana Cloud only: the self-hosted URL is no longer read.';
const NEW_RELIC_SIGN_IN_DETAIL = 'Sign in again to use the New Relic MCP server.';
const NEW_RELIC_API_VIA = 'New Relic API';

/** Keychain items of Loki logs that nothing reads; removed at start. */
const RETIRED_KEYS = [`connection:${ConnectorId.LokiLogs}`];

/** The first AWS CLI with `aws login`. */
const AWS_LOGIN_VERSION = '2.32.0';

/** Whether dotted version `have` is at least `want`. */
function atLeast(have: string, want: string): boolean {
  const a = have.split('.').map(Number);
  const b = want.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

const datasourcesAnswer = z.looseObject({
  datasources: z.array(z.looseObject({ uid: z.string(), name: z.string(), type: z.string() })),
});

/** The pick a Connector waits on: its sign-in finished and the data source or account is still to choose. */
function pickOf(row: Row): Connector['pick'] {
  if (row.status !== HealthStatus.Auth) return null;
  if (row.id === ConnectorId.LokiLogs && row.statusDetail === LOKI_PICK_DETAIL) return 'data_source';
  if (row.id === ConnectorId.NewRelicLogs && row.statusDetail === NEW_RELIC_PICK_DETAIL) return 'account';
  return null;
}

const accountLabelOf = (account: Pickable): string => `${account.name} (${account.id})`;

const invalidConfig = (message: string) => new ApiError(422, ErrorCode.ValidationFailed, message);

/** A hosted server's failure as a picker's error: a refused sign-in is `invalid_state`, any other the server's words. */
function pickerFailure(error: unknown, who: string, connector: string): ApiError {
  if (error instanceof HostedAuthError) {
    return new ApiError(409, ErrorCode.InvalidState, `${connector} is not signed in`);
  }
  return readFailure(error, who);
}

/** A hosted server's failure as the health check reads it (Behavior 13). */
function hostedReading(error: unknown, who: string): Reading {
  const fail = (status: HealthStatus, detail: string): Reading => ({ status, detail, accountLabel: null, login: null });
  if (error instanceof HostedAuthError)
    return fail(HealthStatus.Auth, `${who} needs signing in again: ${error.message}`);
  if (error instanceof HostedUnreachable) return fail(HealthStatus.Fail, `Could not reach ${who}: ${error.reason}`);
  if (error instanceof HostedRateLimited) return fail(HealthStatus.Fail, `${who} rate limit reached`);
  if (error instanceof HostedFailed || error instanceof HostedUnreadable) {
    return fail(HealthStatus.Fail, error.message.slice(0, 300));
  }
  throw error;
}

const INSTALL = {
  aws: 'the AWS CLI with `brew install awscli`',
  uvx: 'uv with `brew install uv`',
};

function missingToolMessage(command: keyof typeof INSTALL): string {
  return `${command} is not installed: install ${INSTALL[command]}, then Connect again`;
}

function signedOutDetail(profile: string): string {
  return `AWS profile ${profile} is signed out. Connect to sign in again.`;
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
