import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type McpOAuthClient, McpScope, McpTransport } from '@ops-console/shared';
import { z } from 'zod';

const entrySchema = z
  .object({
    type: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    oauth: z.object({ clientId: z.string().optional(), callbackPort: z.number().optional() }).loose().optional(),
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
  /** A stdio server's env vars as the config holds them; a launcher-wrapped one reads its own from the Keychain. */
  env?: Record<string, string>;
  /** The pre-registered OAuth app an http server signs in with, when it has one. */
  oauth: McpOAuthClient | null;
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
    env: entry.env ?? {},
    oauth: oauthOf(entry),
  }));
}

function oauthOf(entry: z.infer<typeof entrySchema>): McpOAuthClient | null {
  const { clientId, callbackPort } = entry.oauth ?? {};
  return clientId && callbackPort ? { client_id: clientId, callback_port: callbackPort } : null;
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
      oauth: oauthOf(entry),
    }));
  } catch {
    return [];
  }
}

/** Where an account's own config holds a server; project scope lives in the Repo, not here. */
type ConfigScope = 'user' | 'local' | 'project';

type RawConfig = {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
};

/** Where `scope` keeps its servers in an account's config: the top level for `user`, the folder's entry for `local`. */
function serversOf(
  config: RawConfig,
  scope: ConfigScope,
  localDir: string,
  create: boolean,
): Record<string, unknown> | null {
  if (scope === 'user') {
    if (create) config.mcpServers ??= {};
    return config.mcpServers ?? null;
  }
  if (create) {
    config.projects ??= {};
    config.projects[localDir] ??= {};
    config.projects[localDir].mcpServers ??= {};
  }
  return config.projects?.[localDir]?.mcpServers ?? null;
}

async function readRaw(configDir: string): Promise<RawConfig | null> {
  try {
    const parsed = JSON.parse(await readFile(configFile(configDir), 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as RawConfig) : null;
  } catch {
    return null;
  }
}

/** One server's entry as the account's `.claude.json` holds it, for copying to another account. */
export async function readEntry(
  configDir: string,
  localDir: string,
  scope: ConfigScope,
  name: string,
): Promise<unknown | null> {
  const config = await readRaw(configDir);
  return (config && serversOf(config, scope, localDir, false)?.[name]) ?? null;
}

/**
 * Sets one server's entry in an account's config, or removes it when `entry` is `null`, and leaves every other key as
 * it was. The file is read, changed and renamed into place, as Claude Code writes it; a `claude mcp` call per
 * account costs about a second. A file that does not read as JSON is left alone and the call throws.
 */
export async function writeEntry(
  configDir: string,
  localDir: string,
  scope: ConfigScope,
  name: string,
  entry: unknown | null,
): Promise<void> {
  const file = configFile(configDir);
  let config: RawConfig = {};
  try {
    config = JSON.parse(await readFile(file, 'utf8')) as RawConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (entry === null) {
    const servers = serversOf(config, scope, localDir, false);
    if (!servers || !(name in servers)) return;
    delete servers[name];
  } else {
    const servers = serversOf(config, scope, localDir, true);
    if (servers) servers[name] = entry;
  }
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  await rename(temp, file);
}
