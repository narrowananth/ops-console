import { cp, open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { getSessionMessages, type SessionStore, type SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { Logger } from '@nestjs/common';
import type { Message } from '@ops-console/shared';
import { type ServerLabel, toMessages } from './parts';

/** The folder name Claude Code files a working directory's transcripts under. */
const projectKey = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, '-');

/** A transcript step this slow gets a log line. The parse steps hold the daemon's one thread throughout. */
const SLOW_PARSE_MS = 100;

/** Parsed transcripts kept for the next read, by the size of their files: a Session read often is read again. */
const CACHE_BYTES = 96 * 1024 * 1024;

/** The last bytes of what was parsed, to tell an appended file from a replaced one. */
const TAIL_BYTES = 64;

/** What a transcript's file looked like when it was last read, and what was parsed from it. */
type Parsed = {
  file: string;
  size: number;
  mtimeMs: number;
  /** Bytes parsed so far: up to the last newline. */
  offset: number;
  tail: Buffer;
  lines: SessionStoreEntry[];
  /** The file ends in a line with no newline yet, which is parsed on each read and not kept. */
  partial: boolean;
  /** The SDK's chained entries for this file; empty of meaning while `partial`. */
  chained: unknown[] | null;
  /** `toMessages` of `chained` for one `skip` and `label`. */
  messages: { entries: unknown[]; skipped: number; label: ServerLabel | null; value: Message[] } | null;
};

const sameFile = (cached: Parsed, file: string, info: { size: number; mtimeMs: number }) =>
  cached.file === file && cached.size === info.size && cached.mtimeMs === info.mtimeMs;

function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Claude Code keeps a Session's transcript at `<config dir>/projects/<project key>/<sdk session id>.jsonl`.
 * The console stores no messages; it reads and moves these files.
 */
export class Transcripts {
  private readonly logger = new Logger('transcripts');
  /** By account folder and SDK session id, least recently read first. */
  private readonly parsed = new Map<string, Parsed>();
  /** Where each conversation was last found, so a read looks there first. */
  private readonly found = new Map<string, string>();

  /** Logs a slow step, with the file size where known, to set against the daemon's stall warnings. */
  private warnSlow(what: string, sdkSessionId: string, started: number, bytes?: number): void {
    const ms = Math.round(performance.now() - started);
    if (ms < SLOW_PARSE_MS) return;
    const size = bytes === undefined ? '' : ` (${Math.round(bytes / 1024)} KB)`;
    this.logger.warn(`${what} of session ${sdkSessionId} took ${ms} ms${size}`);
  }

  /** Entries from the transcript in `configDir`, chained by the SDK; empty when the transcript is gone. */
  async read(sdkSessionId: string, workingDir: string, configDir: string): Promise<unknown[]> {
    const started = performance.now();
    const cacheKey = `${configDir}\0${sdkSessionId}`;
    // A file that has not changed since the last read has the same entries.
    const hit = this.parsed.get(cacheKey);
    if (hit?.chained) {
      const key = await this.find(sdkSessionId, configDir, workingDir);
      const file = key === null ? null : path.join(configDir, 'projects', key, `${sdkSessionId}.jsonl`);
      const info = file === null ? null : await stat(file).catch(() => null);
      if (file !== null && info !== null && this.parsed.get(cacheKey) === hit && sameFile(hit, file, info)) {
        this.touch(cacheKey, hit);
        return hit.chained;
      }
    }
    // A store reading `configDir` keeps the read on this account: the SDK's own reader uses this process's
    // `CLAUDE_CONFIG_DIR`, which is the same for every account. It finds the file by session id, so a working
    // directory reached through a symlink still finds its transcript.
    const store: SessionStore = {
      append: async () => {},
      load: async (key) => {
        const projectKey = await this.find(key.sessionId, configDir, workingDir);
        if (projectKey === null) return null;
        return this.lines(cacheKey, path.join(configDir, 'projects', projectKey, `${key.sessionId}.jsonl`));
      },
    };
    // Whole read, file I/O included; the SDK also chains the parsed entries on this thread.
    const entries = await getSessionMessages(sdkSessionId, { dir: workingDir, sessionStore: store });
    const now = this.parsed.get(cacheKey);
    if (now && !now.partial) now.chained = entries;
    this.warnSlow('reading the transcript', sdkSessionId, started);
    return entries;
  }

  /**
   * The transcript as messages, oldest first. The result is kept for as long as the file, `skip` and `label` stay the
   * same, so callers must not change it.
   */
  async messages(
    sdkSessionId: string,
    workingDir: string,
    configDir: string,
    skip: ReadonlySet<string> | undefined,
    label: ServerLabel | null | undefined,
  ): Promise<Message[]> {
    const entries = await this.read(sdkSessionId, workingDir, configDir);
    const parsed = this.parsed.get(`${configDir}\0${sdkSessionId}`);
    const skipped = skip?.size ?? 0;
    const kept = parsed?.messages;
    if (kept && kept.entries === entries && kept.skipped === skipped && kept.label === (label ?? null))
      return kept.value;
    const value = toMessages(entries, skip, label);
    if (parsed) parsed.messages = { entries, skipped, label: label ?? null, value };
    return value;
  }

  /**
   * The parsed lines of `file`. A file that only grew is parsed from where the last read stopped; one that shrank or
   * whose earlier bytes changed is parsed again from the start.
   */
  private async lines(cacheKey: string, file: string): Promise<SessionStoreEntry[]> {
    const info = await stat(file);
    let cached = this.parsed.get(cacheKey);
    if (cached && !cached.partial && sameFile(cached, file, info)) {
      this.touch(cacheKey, cached);
      return cached.lines;
    }
    const started = performance.now();
    const handle = await open(file, 'r');
    try {
      if (cached && (cached.file !== file || info.size < cached.offset || !(await this.sameTail(handle, cached)))) {
        cached = undefined;
      }
      const from = cached?.offset ?? 0;
      const buffer = Buffer.alloc(Math.max(0, info.size - from));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      const read = buffer.subarray(0, bytesRead);
      const end = read.lastIndexOf(0x0a) + 1;
      const lines = [...(cached?.lines ?? [])];
      for (const line of read.toString('utf8', 0, end).split('\n'))
        if (line.trim()) lines.push(JSON.parse(line) as SessionStoreEntry);
      // A last line with no newline yet may be cut mid-write: it counts once it parses, and is parsed again next read.
      const rest = read.toString('utf8', end).trim();
      const last = rest ? (parseOrNull(rest) as SessionStoreEntry | null) : null;
      this.touch(cacheKey, {
        file,
        size: info.size,
        mtimeMs: info.mtimeMs,
        offset: from + end,
        tail: Buffer.from(read.subarray(Math.max(0, end - TAIL_BYTES), end)),
        lines,
        partial: rest !== '',
        chained: null,
        messages: null,
      });
      this.warnSlow('parsing the transcript', cacheKey.split('\0')[1] ?? '', started, bytesRead);
      return last === null ? lines : [...lines, last];
    } finally {
      await handle.close();
    }
  }

  /** Marks the entry as the most recently read and drops the oldest ones past the budget. */
  private touch(cacheKey: string, entry: Parsed): void {
    this.parsed.delete(cacheKey);
    this.parsed.set(cacheKey, entry);
    let total = 0;
    for (const kept of this.parsed.values()) total += kept.size;
    for (const [key, kept] of this.parsed) {
      if (total <= CACHE_BYTES || this.parsed.size <= 1) return;
      total -= kept.size;
      this.parsed.delete(key);
    }
  }

  /** Whether the bytes before `cached.offset` are still the ones that were parsed. */
  private async sameTail(handle: Awaited<ReturnType<typeof open>>, cached: Parsed): Promise<boolean> {
    const tail = Buffer.alloc(cached.tail.length);
    await handle.read(tail, 0, tail.length, cached.offset - tail.length);
    return tail.equals(cached.tail);
  }

  /** The newest name Claude Code gave the conversation (`ai-title` entries); null when it has not named it yet. */
  async aiTitle(sdkSessionId: string, configDir: string): Promise<string | null> {
    const key = await this.find(sdkSessionId, configDir);
    if (key === null) return null;
    const text = await readFile(path.join(configDir, 'projects', key, `${sdkSessionId}.jsonl`), 'utf8');
    const started = performance.now();
    let title: string | null = null;
    for (const line of text.split('\n')) {
      if (!line.includes('"ai-title"')) continue;
      try {
        const entry = JSON.parse(line) as { type?: unknown; aiTitle?: unknown };
        if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
          title = entry.aiTitle.trim();
        }
      } catch {
        // A line cut mid-write is read on the next try.
      }
    }
    this.warnSlow('scanning the transcript for its title', sdkSessionId, started, text.length);
    return title;
  }

  async exists(sdkSessionId: string, configDir: string): Promise<boolean> {
    return (await this.find(sdkSessionId, configDir)) !== null;
  }

  /** Copies the transcript, and its folder of subagent files when there is one, into another config dir. */
  async copy(sdkSessionId: string, fromConfigDir: string, toConfigDir: string): Promise<void> {
    const projectKey = await this.find(sdkSessionId, fromConfigDir);
    if (projectKey === null) return;
    const from = path.join(fromConfigDir, 'projects', projectKey);
    const to = path.join(toConfigDir, 'projects', projectKey);
    await cp(path.join(from, `${sdkSessionId}.jsonl`), path.join(to, `${sdkSessionId}.jsonl`));
    const folder = path.join(from, sdkSessionId);
    if (
      await stat(folder).then(
        (entry) => entry.isDirectory(),
        () => false,
      )
    ) {
      await cp(folder, path.join(to, sdkSessionId), { recursive: true });
    }
  }

  /**
   * Copies the transcript under the project folder Claude Code reads for `cwd`, when it sits under another one. A
   * conversation begun in a Verification's scratch copy then resumes in the checkout.
   */
  async place(sdkSessionId: string, configDir: string, cwd: string): Promise<void> {
    const from = await this.find(sdkSessionId, configDir);
    if (from === null) return;
    const real = await realpath(cwd).catch(() => cwd);
    for (const key of new Set([projectKey(cwd), projectKey(real)])) {
      if (key === from) continue;
      const source = path.join(configDir, 'projects', from);
      const target = path.join(configDir, 'projects', key);
      await cp(path.join(source, `${sdkSessionId}.jsonl`), path.join(target, `${sdkSessionId}.jsonl`));
    }
  }

  /**
   * The project folder holding the conversation's newest copy. With a `workingDir`, which a read has, the folders
   * where the conversation was found before and under the working directory's own key come first, and the full scan
   * runs only when neither has it. Without one, which a move has, every folder is looked at.
   */
  private async find(sdkSessionId: string, configDir: string, workingDir?: string): Promise<string | null> {
    const projects = path.join(configDir, 'projects');
    const cacheKey = `${configDir}\0${sdkSessionId}`;
    const mtimeOf = (key: string) =>
      stat(path.join(projects, key, `${sdkSessionId}.jsonl`)).then(
        (entry) => entry.mtimeMs,
        () => null,
      );
    // A conversation moved between folders has a copy in each; the one written last is current.
    const newest = async (keys: Iterable<string>) => {
      let best: { key: string; at: number } | null = null;
      for (const key of keys) {
        const at = await mtimeOf(key);
        if (at !== null && (best === null || at > best.at)) best = { key, at };
      }
      return best?.key ?? null;
    };
    const remembered = this.found.get(cacheKey);
    let key = workingDir ? await newest(new Set([...(remembered ? [remembered] : []), projectKey(workingDir)])) : null;
    if (key === null) {
      const keys = await readdir(projects).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      key = await newest(keys);
    }
    if (key === null) this.found.delete(cacheKey);
    else this.found.set(cacheKey, key);
    return key;
  }

  /** Deletes the conversation's transcript, and its folder of subagent files, from each config dir. */
  async remove(sdkSessionId: string, configDirs: string[]): Promise<void> {
    for (const configDir of configDirs) {
      const projects = path.join(configDir, 'projects');
      const keys = await readdir(projects).catch(() => []);
      for (const key of keys) {
        await rm(path.join(projects, key, `${sdkSessionId}.jsonl`), { force: true });
        await rm(path.join(projects, key, sdkSessionId), { recursive: true, force: true });
      }
      this.parsed.delete(`${configDir}\0${sdkSessionId}`);
      this.found.delete(`${configDir}\0${sdkSessionId}`);
    }
  }

  /** Deletes transcripts that no Session holds and that nothing wrote for `olderThanMs`. Returns how many went. */
  async sweep(configDirs: string[], held: ReadonlySet<string>, olderThanMs: number): Promise<number> {
    const before = Date.now() - olderThanMs;
    let removed = 0;
    for (const configDir of configDirs) {
      const projects = path.join(configDir, 'projects');
      for (const key of await readdir(projects).catch(() => [])) {
        for (const name of await readdir(path.join(projects, key)).catch(() => [])) {
          if (!name.endsWith('.jsonl') || held.has(name.slice(0, -'.jsonl'.length))) continue;
          const file = path.join(projects, key, name);
          const info = await stat(file).catch(() => null);
          if (info === null || info.mtimeMs > before) continue;
          const id = name.slice(0, -'.jsonl'.length);
          await rm(file, { force: true });
          await rm(path.join(projects, key, id), { recursive: true, force: true });
          this.parsed.delete(`${configDir}\0${id}`);
          this.found.delete(`${configDir}\0${id}`);
          removed++;
        }
      }
    }
    return removed;
  }
}
