import type { ClaudeCredentials, StoredToken } from '../../src/connectors/claude-credentials';

/** What Claude Code keeps for each MCP server, by name: the token, or none when the server has no sign-in or macOS refuses the read. */
export class FakeClaudeCredentials implements ClaudeCredentials {
  private readonly tokens = new Map<string, StoredToken>();
  /** Every read, as the server name and the address the console looked for. */
  readonly reads: { name: string; url: string }[] = [];
  /** The operator refuses the macOS prompt: every read finds nothing. */
  refused = false;

  /** Claude Code holds `token` for the server `name`, ending at `expiresAt` ms when it is known. */
  hold(name: string, accessToken: string, expiresAt: number | null = Date.now() + 3_600_000): void {
    this.tokens.set(name, { accessToken, expiresAt });
  }

  forget(name: string): void {
    this.tokens.delete(name);
  }

  async mcpToken(name: string, url: string): Promise<StoredToken | null> {
    this.reads.push({ name, url });
    return this.refused ? null : (this.tokens.get(name) ?? null);
  }
}
