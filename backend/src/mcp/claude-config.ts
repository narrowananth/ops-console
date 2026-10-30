import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { McpScope, McpTransport } from '@ops-console/shared';
import { z } from 'zod';

const entrySchema = z
  .object({
    type: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .loose();

const fileSchema = z
  .object({
    mcpServers: z.record(z.string(), entrySchema).optional(),
    projects: z
      .record(z.string(), z.object({ mcpServers: z.record(z.string(), entrySchema).optional() }).loose())
      .optional(),
  })
  .loose();

export type RegisteredScope = McpScope;

/** One server as an account's `.claude.json` holds it. Header values stay inside the backend. */
export type RegisteredServer = {
  name: string;
  scope: RegisteredScope;
  transport: McpTransport;
  /** The command line or URL as registered, launcher included. */
  command: string;
  args: string[];
  url: string | null;
  headers: Record<string, string>;
};

export function configFile(configDir: string): string {
  return path.join(configDir, '.claude.json');
}

/**
 * The user scope servers and the `local` ones of `localDir` in one account's config. Read from the file, not from
 * `claude mcp list`, which starts every server each time it runs.
 */
export async function readRegistered(configDir: string, localDir: string): Promise<RegisteredServer[]> {
  let text: string;
  try {
    text = await readFile(configFile(configDir), 'utf8');
  } catch {
    return [];
  }
  // Claude Code rewrites this file often; a half-written copy reads as no servers until the next list.
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) return [];
  const file = parsed.data;
  type Entry = z.infer<typeof entrySchema>;
  const entries: { scope: RegisteredScope; name: string; entry: Entry }[] = [
    ...Object.entries(file.mcpServers ?? {}).map(([name, entry]) => ({ scope: McpScope.User as const, name, entry })),
    ...Object.entries(file.projects?.[localDir]?.mcpServers ?? {}).map(([name, entry]) => ({
      scope: McpScope.Local as const,
      name,
      entry,
    })),
  ];
  return entries.map(({ scope, name, entry }) => ({
    name,
    scope,
    transport: entry.type === 'http' || entry.type === 'sse' ? (entry.type as McpTransport) : McpTransport.Stdio,
    command: entry.command ?? '',
    args: entry.args ?? [],
    url: entry.url ?? null,
    headers: entry.headers ?? {},
  }));
}

const projectFileSchema = z.object({ mcpServers: z.record(z.string(), entrySchema).optional() }).loose();

/** The servers a Repo's `.mcp.json` holds. A missing or half-written file reads as none. */
export async function readProject(repoPath: string): Promise<RegisteredServer[]> {
  try {
    const parsed = projectFileSchema.safeParse(JSON.parse(await readFile(path.join(repoPath, '.mcp.json'), 'utf8')));
    if (!parsed.success) return [];
    return Object.entries(parsed.data.mcpServers ?? {}).map(([name, entry]) => ({
      name,
      scope: McpScope.Project,
      transport: entry.type === 'http' || entry.type === 'sse' ? (entry.type as McpTransport) : McpTransport.Stdio,
      command: entry.command ?? '',
      args: entry.args ?? [],
      url: entry.url ?? null,
      headers: entry.headers ?? {},
    }));
  } catch {
    return [];
  }
}
