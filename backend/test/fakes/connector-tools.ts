import { ErrorCode } from '@ops-console/shared';
import { ApiError } from '../../src/common/errors';
import type { ConnectorTools } from '../../src/connectors/connector-tools';

/** `pup`, `gh`, `glab` and the Bitbucket API as scripted state. Sign-ins succeed unless a test says otherwise. */
export class FakeConnectorTools implements ConnectorTools {
  datadog: { signedIn: boolean; org: string | null } = { signedIn: false, org: null };
  datadogMcp = true;
  github: string | null = null;
  gitlab: string | null = null;
  bitbucketTokens = new Map<string, string>();
  /** The next sign-in fails, or waits for its signal to abort. */
  next: 'ok' | 'fail' | 'hang' = 'ok';
  readonly gitlabTokens: string[] = [];
  down = false;

  private async login(signal?: AbortSignal): Promise<void> {
    if (this.next === 'fail') throw new ApiError(502, ErrorCode.UpstreamFailed, '`login` failed');
    if (this.next === 'hang') {
      await new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
  }

  private check(): void {
    if (this.down) throw new ApiError(502, ErrorCode.UpstreamFailed, '`tool` failed');
  }

  async datadogStatus() {
    this.check();
    return this.datadog;
  }

  async datadogLogin(_site: string, signal: AbortSignal): Promise<void> {
    await this.login(signal);
    this.datadog = { signedIn: true, org: 'example-org' };
  }

  async datadogHasMcp(): Promise<boolean> {
    return this.datadogMcp;
  }

  async githubUser(): Promise<string | null> {
    this.check();
    return this.github;
  }

  async githubLogin(signal: AbortSignal): Promise<void> {
    await this.login(signal);
    this.github = 'octo-operator';
  }

  async gitlabUser(): Promise<string | null> {
    this.check();
    return this.gitlab;
  }

  async gitlabLogin(_host: string, token: string): Promise<void> {
    this.gitlabTokens.push(token);
    await this.login();
    this.gitlab = 'gl-operator';
  }

  async bitbucketUser(token: string): Promise<string | null> {
    this.check();
    return this.bitbucketTokens.get(token) ?? null;
  }
}
