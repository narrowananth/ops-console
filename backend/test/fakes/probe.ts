import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readProject, readRegistered } from '../../src/mcp/claude-config';
import type { OneServer, Probe, ProbedServer } from '../../src/mcp/probe';

/**
 * Reports every server the account's config registers as connected with one tool, unless a test scripted another
 * state. A server scripted `needs-auth` reads connected once `claude mcp login` has recorded it.
 */
export class FakeProbe implements Probe {
  runs = 0;
  /** How long each Probe takes, as Claude Code starting its servers does. */
  delayMs = 0;
  private readonly scripted = new Map<string, Partial<ProbedServer>>();
  private readonly broken = new Set<string>();
  private readonly approved = new Set<string>();

  set(configDir: string, name: string, state: Partial<ProbedServer>): void {
    this.scripted.set(`${configDir}\n${name}`, state);
  }

  /** Claude Code loads a Repo's `.mcp.json` server only after the operator approves it there. */
  approve(configDir: string, name: string): void {
    this.approved.add(`${configDir}\n${name}`);
  }

  breakAccount(configDir: string): void {
    this.broken.add(configDir);
  }

  /** `one` runs; it never waits `delayMs`, as one server connects in seconds. */
  ones = 0;

  async one(configDir: string, server: OneServer): Promise<ProbedServer> {
    this.ones += 1;
    if (this.broken.has(configDir)) throw new Error('Claude did not answer');
    return this.read(configDir, server.name);
  }

  async run(configDir: string, cwd: string): Promise<ProbedServer[]> {
    this.runs += 1;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.broken.has(configDir)) throw new Error('Claude did not answer');
    const project = (await readProject(cwd)).filter(({ name }) => this.approved.has(`${configDir}\n${name}`));
    return [...(await readRegistered(configDir, cwd)), ...project].map(({ name }) => this.read(configDir, name));
  }

  private read(configDir: string, name: string): ProbedServer {
    const authFile = path.join(configDir, 'fake-mcp-auth.json');
    const signedIn: string[] = existsSync(authFile) ? JSON.parse(readFileSync(authFile, 'utf8')) : [];
    const state = this.scripted.get(`${configDir}\n${name}`);
    const status =
      state?.status === 'needs-auth' && signedIn.includes(name) ? 'connected' : (state?.status ?? 'connected');
    return {
      name,
      status,
      error: state?.error ?? null,
      tools: status === 'connected' ? (state?.tools ?? ['ping']) : [],
    };
  }
}
