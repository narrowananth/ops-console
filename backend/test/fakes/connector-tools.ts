import { ErrorCode } from '@ops-console/shared';
import { ApiError } from '../../src/common/errors';
import type { ConnectorTools, SignInPrompt } from '../../src/connectors/connector-tools';

/** `pup`, `gh` and `glab` as scripted state. Sign-ins succeed unless a test says otherwise. */
export class FakeConnectorTools implements ConnectorTools {
  datadog: { signedIn: boolean; org: string | null } = { signedIn: false, org: null };
  datadogMcp = true;
  github: string | null = null;
  gitlab: string | null = null;
  bitbucket: string | null = null;
  /** The next sign-in fails, or waits for its signal to abort. */
  next: 'ok' | 'fail' | 'hang' = 'ok';
  /** What `gh` prints for the browser step. */
  githubPrompt: SignInPrompt = { code: 'WXYZ-1234', url: 'https://github.com/login/device' };
  readonly gitlabLogins: string[] = [];
  down = false;
  /** Commands not on the PATH; `brew install` puts one there. */
  missing = new Set<string>();
  readonly brewed: string[] = [];

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

  async datadogLogin(_site: string, signal: AbortSignal, _onPrompt: (prompt: SignInPrompt) => void): Promise<void> {
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

  async githubLogin(signal: AbortSignal, onPrompt: (prompt: SignInPrompt) => void): Promise<void> {
    onPrompt(this.githubPrompt);
    await this.login(signal);
    this.github = 'octo-operator';
  }

  async bitbucketUser(): Promise<string | null> {
    this.check();
    return this.bitbucket;
  }

  async bitbucketLogin(signal: AbortSignal, _onPrompt: (prompt: SignInPrompt) => void): Promise<void> {
    await this.login(signal);
    this.bitbucket = 'bb-operator';
  }

  async githubToken(): Promise<string | null> {
    return this.github === null ? null : 'gho_example_token';
  }

  async gitlabUser(): Promise<string | null> {
    this.check();
    return this.gitlab;
  }

  async gitlabLogin(host: string, signal: AbortSignal, _onPrompt: (prompt: SignInPrompt) => void): Promise<void> {
    this.gitlabLogins.push(host);
    await this.login(signal);
    this.gitlab = 'gl-operator';
  }

  async installed(command: string): Promise<boolean> {
    return !this.missing.has(command);
  }

  async install(formula: string): Promise<void> {
    this.brewed.push(formula);
    this.missing.delete(formula);
  }
}
