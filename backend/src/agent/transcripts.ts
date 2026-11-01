import { cp, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { getSessionMessages, type SessionStore } from '@anthropic-ai/claude-agent-sdk';

/** The folder name Claude Code files a working directory's transcripts under. */
const projectKey = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, '-');

/**
 * Claude Code keeps a Session's transcript at `<config dir>/projects/<project key>/<sdk session id>.jsonl`.
 * The console stores no messages; it reads and moves these files.
 */
export class Transcripts {
  /** Entries from the transcript in `configDir`, chained by the SDK; empty when the transcript is gone. */
  async read(sdkSessionId: string, workingDir: string, configDir: string): Promise<unknown[]> {
    // A store reading `configDir` keeps the read on this account: the SDK's own reader uses this process's
    // `CLAUDE_CONFIG_DIR`, which is the same for every account. It finds the file by session id, so a working
    // directory reached through a symlink still finds its transcript.
    const store: SessionStore = {
      append: async () => {},
      load: async (key) => {
        const projectKey = await this.find(key.sessionId, configDir);
        if (projectKey === null) return null;
        const file = path.join(configDir, 'projects', projectKey, `${key.sessionId}.jsonl`);
        const text = await readFile(file, 'utf8');
        return text
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
      },
    };
    return getSessionMessages(sdkSessionId, { dir: workingDir, sessionStore: store });
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

  private async find(sdkSessionId: string, configDir: string): Promise<string | null> {
    const projects = path.join(configDir, 'projects');
    const keys = await readdir(projects).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    // A conversation moved between folders has a copy in each; the one written last is current.
    let newest: { key: string; at: number } | null = null;
    for (const key of keys) {
      const at = await stat(path.join(projects, key, `${sdkSessionId}.jsonl`)).then(
        (entry) => entry.mtimeMs,
        () => null,
      );
      if (at !== null && (newest === null || at > newest.at)) newest = { key, at };
    }
    return newest?.key ?? null;
  }
}
