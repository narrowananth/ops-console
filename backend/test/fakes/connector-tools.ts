import { type AwsProfile, ErrorCode } from '@ops-console/shared';
import { ApiError } from '../../src/common/errors';
import type { ConnectorTools, SignInPrompt } from '../../src/connectors/connector-tools';

/** `pup`, `gh` and `glab` as scripted state. Sign-ins succeed unless a test says otherwise. */
export class FakeConnectorTools implements ConnectorTools {
  datadog: { signedIn: boolean; org: string | null } = { signedIn: false, org: null };
  datadogMcp = true;
  github: string | null = null;
  gitlab: string | null = null;
  bitbucket: string | null = null;
  slashdocs: { email: string; name: string | null } | null = null;
  readonly slashdocsLogins: (string | null)[] = [];
  /** The next sign-in fails, or waits for its signal to abort. */
  next: 'ok' | 'fail' | 'hang' = 'ok';
  /** What `gh` prints for the browser step. */
  githubPrompt: SignInPrompt = { code: 'WXYZ-1234', url: 'https://github.com/login/device' };
  readonly gitlabLogins: string[] = [];
  down = false;
  /** The AWS profiles that are signed in, and the ones that sign in with Identity Center. */
  awsSignedInProfiles = new Set<string>();
  awsSsoProfiles = new Set<string>();
  /** The log groups the signed-in profile sees. */
  awsGroups: string[] = [];
  /** Each `aws sso login` or `aws login`, by profile, and each `describe-log-groups` call. */
  readonly awsLogins: string[] = [];
  readonly awsLoginKinds: ('sso' | 'console')[] = [];
  readonly awsLoginRegions: string[] = [];
  readonly awsListed: { profile: string; region: string }[] = [];
  /** The AWS CLI's version, and the profiles in its config. */
  awsCliVersion: string | null = '2.32.1';
  awsConfigured: AwsProfile[] = [];
  /** Commands not on the PATH; `brew install` puts one there. */
  missing = new Set<string>();
  readonly brewed: string[] = [];
  /** Pages opened in the operator's browser. */
  readonly opened: string[] = [];

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

  async slashdocsUser() {
    this.check();
    return this.slashdocs;
  }

  async slashdocsLogin(server: string | null, signal: AbortSignal, _onPrompt: (prompt: SignInPrompt) => void) {
    this.slashdocsLogins.push(server);
    await this.login(signal);
    this.slashdocs = { email: 'operator@example.com', name: 'Operator' };
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

  async awsSignedIn(profile: string): Promise<boolean> {
    return this.awsSignedInProfiles.has(profile);
  }

  async awsIsSso(profile: string): Promise<boolean> {
    return this.awsSsoProfiles.has(profile);
  }

  async awsVersion(): Promise<string | null> {
    return this.awsCliVersion;
  }

  async awsProfiles(): Promise<AwsProfile[]> {
    return this.awsConfigured;
  }

  async awsLogin(
    profile: string,
    region: string,
    kind: 'sso' | 'console',
    signal: AbortSignal,
    _onPrompt: (prompt: SignInPrompt) => void,
  ): Promise<void> {
    this.awsLogins.push(profile);
    this.awsLoginKinds.push(kind);
    this.awsLoginRegions.push(region);
    await this.login(signal);
    this.awsSignedInProfiles.add(profile);
  }

  async awsLogGroups(profile: string, region: string): Promise<string[]> {
    this.awsListed.push({ profile, region });
    if (!this.awsSignedInProfiles.has(profile))
      throw new ApiError(502, ErrorCode.UpstreamFailed, '`aws logs describe-log-groups` failed');
    return this.awsGroups;
  }

  async openPage(url: string): Promise<void> {
    this.opened.push(url);
  }

  async installed(command: string): Promise<boolean> {
    return !this.missing.has(command);
  }

  /** Each `brew install` call, so a test sees one command for several formulas. */
  readonly brewCalls: string[][] = [];

  async install(formulas: string[]): Promise<void> {
    this.brewCalls.push(formulas);
    for (const formula of formulas) {
      this.brewed.push(formula);
      this.missing.delete(formula);
    }
  }
}
