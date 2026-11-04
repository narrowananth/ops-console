import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  type CliProxy,
  type CliProxySetting,
  CliProxyStatus,
  cliProxySettingSchema,
  ErrorCode,
} from '@ops-console/shared';
import { ApiError } from '../common/errors';
import { KEYCHAIN, type Keychain } from '../keychain/keychain';
import { SettingsRegistry } from '../settings/settings.registry';
import { SettingsService } from '../settings/settings.service';

export const CLIPROXY = 'cliproxy';

/** The Keychain item holding the API key runs send to CLIProxy (ADR 0004). */
export const CLIPROXY_KEY = 'cliproxy:api-key';

const CHECK_TIMEOUT_MS = 5_000;

type Check = { status: CliProxyStatus; detail: string | null; at: string | null };

/**
 * CLIProxy as the Claude account hub: while it is on, runs sign in to Claude through CLIProxy's API key in place of
 * a Claude account, and CLIProxy picks the account and tracks the quota.
 */
@Injectable()
export class CliProxyService implements OnApplicationBootstrap {
  private readonly logger = new Logger('cliproxy');
  private last: Check = { status: CliProxyStatus.Unchecked, detail: null, at: null };
  private hasKey: boolean | null = null;

  constructor(
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(KEYCHAIN) private readonly keychain: Keychain,
    @Inject(SettingsRegistry) registry: SettingsRegistry,
  ) {
    registry.register({
      key: CLIPROXY,
      schema: cliProxySettingSchema,
      default: { enabled: false, address: 'http://127.0.0.1:8317' },
      // A new address may answer differently.
      onChange: () => void this.check().catch(() => {}),
    });
  }

  onApplicationBootstrap(): void {
    void this.check().catch(() => {});
  }

  setting(): CliProxySetting {
    return this.settings.get(CLIPROXY, cliProxySettingSchema);
  }

  enabled(): boolean {
    return this.setting().enabled;
  }

  /** Refuses a run while the hub is on with no key, before it starts; `env` refuses one that gets past. */
  assertReady(): void {
    if (this.enabled() && this.hasKey === false) throw noKey();
  }

  async view(): Promise<CliProxy> {
    const { enabled, address } = this.setting();
    const hasKey = await this.keyExists();
    return {
      enabled,
      address,
      has_key: hasKey,
      status: hasKey ? this.last.status : CliProxyStatus.NoKey,
      status_detail: hasKey ? this.last.detail : null,
      checked_at: hasKey ? this.last.at : null,
    };
  }

  async saveKey(key: string): Promise<CliProxy> {
    await this.keychain.set(CLIPROXY_KEY, key);
    this.hasKey = true;
    return this.check();
  }

  /** Runs stop signing in through CLIProxy without a key, so the hub goes off with it. */
  async deleteKey(): Promise<CliProxy> {
    await this.keychain.delete(CLIPROXY_KEY).catch(() => {});
    this.hasKey = false;
    this.last = { status: CliProxyStatus.Unchecked, detail: null, at: null };
    if (this.enabled()) this.settings.update({ [CLIPROXY]: { ...this.setting(), enabled: false } });
    return this.view();
  }

  /** Asks CLIProxy for its models with the saved key: it answers 200 to a key in its `access.api-keys`. */
  async check(): Promise<CliProxy> {
    const key = await this.keychain.get(CLIPROXY_KEY);
    this.hasKey = key !== null;
    if (key === null) return this.view();
    const { address } = this.setting();
    const at = new Date().toISOString();
    try {
      const response = await fetch(`${base(address)}/v1/models`, {
        headers: { authorization: `Bearer ${key}`, 'x-api-key': key },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      this.last =
        response.status === 200
          ? { status: CliProxyStatus.Connected, detail: null, at }
          : response.status === 401 || response.status === 403
            ? { status: CliProxyStatus.Refused, detail: `CLIProxy refused the API key (${response.status})`, at }
            : { status: CliProxyStatus.Unreachable, detail: `CLIProxy answered ${response.status}`, at };
    } catch (error) {
      this.logger.warn(`checking ${address} failed: ${error instanceof Error ? error.message : String(error)}`);
      this.last = { status: CliProxyStatus.Unreachable, detail: `Nothing answers at ${address}`, at };
    }
    return this.view();
  }

  /**
   * What a run's `claude` needs to go through CLIProxy, on top of the account's environment; empty while the hub is
   * off. The token beats the config dir's own sign-in.
   */
  async env(): Promise<Record<string, string>> {
    const { enabled, address } = this.setting();
    if (!enabled) return {};
    const key = await this.keychain.get(CLIPROXY_KEY);
    if (key === null) throw noKey();
    return { ANTHROPIC_BASE_URL: base(address), ANTHROPIC_AUTH_TOKEN: key };
  }

  private async keyExists(): Promise<boolean> {
    this.hasKey ??= (await this.keychain.get(CLIPROXY_KEY)) !== null;
    return this.hasKey;
  }
}

const base = (address: string) => address.trim().replace(/\/+$/, '');

const noKey = () => new ApiError(409, ErrorCode.InvalidState, 'CLIProxy has no API key: add one in Agents & accounts');
