import { constants, mkdirSync, type ReadStream } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode, type OutputFile } from '@ops-console/shared';
import { z } from 'zod';
import { DATA_DIR } from '../common/data-dir';
import { ApiError } from '../common/errors';
import { fileType } from './attachments';

export const saveFileInputSchema = z.object({
  /** A file or folder name in the Session's output folder. */
  name: z.string().trim().min(1),
  /** The absolute path of a folder that exists, or one under `~/`. */
  folder: z.string().trim().min(1),
});

export type SaveFileInput = z.infer<typeof saveFileInputSchema>;

/** What the agent's `save_file` tool calls. */
export interface FileSaver {
  /** The words the operator's Approval shows. Throws an `ApiError` when the file or folder cannot be used. */
  describe(sessionId: string, input: SaveFileInput): Promise<string>;
  /** Copies the file into the folder; returns the path written. */
  save(sessionId: string, input: SaveFileInput): Promise<string>;
}

/** The tool's answer to the agent: the path written, or why nothing was copied. */
export async function runSaveFile(
  saver: FileSaver,
  sessionId: string,
  input: SaveFileInput,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    const written = await saver.save(sessionId, input);
    return { content: [{ type: 'text', text: `Saved the file to ${written}` }] };
  } catch (error) {
    const why = error instanceof ApiError ? error.message : 'the file was not copied';
    return { content: [{ type: 'text', text: `The file was not saved: ${why}` }], isError: true };
  }
}

/** A bare file name: no folder part, no leading dot. */
const bare = (name: string) => name === path.basename(name) && !name.startsWith('.');

const notFound = () => new ApiError(404, ErrorCode.NotFound, 'No such output file');

const bytes = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${Math.round(size / 1024)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;

/**
 * Files the agent writes for the operator: one folder per Session under the data folder. The daemon serves only plain files in it, by bare name, and copies one elsewhere only after
 * the operator's Approval.
 */
@Injectable()
export class OutputFiles implements FileSaver {
  constructor(@Inject(DATA_DIR) private readonly dataDir: string) {}

  folder(sessionId: string): string {
    return path.join(this.dataDir, 'outputs', sessionId);
  }

  /** The Session's folder, made if it is missing, for a run to write in. */
  ensure(sessionId: string): string {
    const folder = this.folder(sessionId);
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  /** Plain files in the folder, A to Z; a subfolder, a symlink and a dot file are left out. */
  async list(sessionId: string): Promise<OutputFile[]> {
    let names: string[];
    try {
      names = await readdir(this.folder(sessionId));
    } catch {
      return [];
    }
    const files: OutputFile[] = [];
    for (const name of names.filter(bare)) {
      const found = await this.plain(sessionId, name);
      if (found) files.push({ name, size: found.size, modified_at: found.mtime.toISOString() });
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(sessionId: string, name: string): Promise<{ stream: ReadStream; type: string; size: number }> {
    const opened = await this.openPlain(sessionId, name);
    if (!opened) throw notFound();
    return { stream: opened.handle.createReadStream(), type: fileType(name), size: opened.size };
  }

  async remove(sessionId: string): Promise<void> {
    await rm(this.folder(sessionId), { recursive: true, force: true });
  }

  async describe(sessionId: string, input: SaveFileInput): Promise<string> {
    return (await this.plan(sessionId, input)).summary;
  }

  async save(sessionId: string, input: SaveFileInput): Promise<string> {
    const { source, to } = await this.plan(sessionId, input);
    if (source.kind === 'dir') return this.saveFolder(sessionId, input.name, source.files, to);
    const opened = await this.openPlain(sessionId, input.name);
    if (!opened) throw notFound();
    // The agent writes in the source folder and may write in the destination: neither end follows a symlink.
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
    const target = await open(to, flags).catch(() => null);
    if (!target) {
      await opened.handle.close();
      throw new ApiError(400, ErrorCode.ValidationFailed, `Cannot write ${to}`);
    }
    await pipeline(opened.handle.createReadStream(), target.createWriteStream());
    return to;
  }

  /** What a save would copy and where, with the words the Approval shows. Throws when it cannot be done. */
  private async plan(sessionId: string, input: SaveFileInput) {
    const source = bare(input.name) ? await this.source(sessionId, input.name) : null;
    if (!source) throw new ApiError(404, ErrorCode.NotFound, `No file ${input.name} in your output folder`);
    const folder = await this.destination(input.folder);
    const to = path.join(folder, input.name);
    const there = await lstat(to).catch(() => null);
    if (source.kind === 'file') {
      const replaces = there?.isFile() ? ' (replaces the file of that name there)' : '';
      return { source, to, summary: `Save ${input.name} (${bytes(source.size)}) to ${folder}${path.sep}${replaces}` };
    }
    if (there) throw new ApiError(400, ErrorCode.ValidationFailed, `${to} exists already`);
    const noun = source.files.length === 1 ? 'file' : 'files';
    const head = `Save ${input.name}/ (${source.files.length} ${noun}, ${bytes(source.size)}) to ${folder}${path.sep}`;
    return { source, to, summary: [head, ...source.files.map((file) => file.rel)].join('\n') };
  }

  /** Copies the listed files into a folder the daemon makes here. A failed copy removes the folder it made. */
  private async saveFolder(sessionId: string, name: string, files: { rel: string }[], to: string): Promise<string> {
    // Not recursive: a folder that appeared since the check stops the copy, never merges into it.
    await mkdir(to).catch(() => {
      throw new ApiError(400, ErrorCode.ValidationFailed, `Cannot write ${to}`);
    });
    try {
      const root = await realpath(path.join(this.folder(sessionId), name));
      for (const { rel } of files) {
        const from = path.join(this.folder(sessionId), name, rel);
        const handle = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
        const info = await handle?.stat();
        // The agent can swap a folder for a link after the check: the open file must sit where the list said.
        if (!handle || !info?.isFile() || info.nlink !== 1 || (await realpath(from)) !== path.join(root, rel)) {
          await handle?.close();
          throw new ApiError(400, ErrorCode.ValidationFailed, `${rel} changed while copying`);
        }
        await mkdir(path.dirname(path.join(to, rel)), { recursive: true });
        const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
        const target = await open(path.join(to, rel), flags).catch(() => null);
        if (!target) {
          await handle.close();
          throw new ApiError(400, ErrorCode.ValidationFailed, `Cannot write ${path.join(to, rel)}`);
        }
        await pipeline(handle.createReadStream(), target.createWriteStream());
      }
    } catch (error) {
      await rm(to, { recursive: true, force: true });
      throw error;
    }
    return to;
  }

  /**
   * Opens a plain file of the folder, never through a symlink, and checks the open file itself: the agent can swap a
   * name for a link between a check and a read. A file with another hard link is refused, since a link to a file
   * outside this folder would read through it.
   */
  private async openPlain(sessionId: string, name: string): Promise<{ handle: FileHandle; size: number } | null> {
    if (!bare(name)) return null;
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
    const handle = await open(path.join(this.folder(sessionId), name), flags).catch(() => null);
    if (!handle) return null;
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) {
      await handle.close();
      return null;
    }
    return { handle, size: info.size };
  }

  /** A plain file, or a folder of plain files, never through a link. A link or odd file in a folder refuses it whole. */
  private async source(
    sessionId: string,
    name: string,
  ): Promise<
    { kind: 'file'; size: number } | { kind: 'dir'; size: number; files: { rel: string; size: number }[] } | null
  > {
    const top = path.join(this.folder(sessionId), name);
    const info = await lstat(top).catch(() => null);
    if (info?.isFile()) return info.nlink === 1 ? { kind: 'file', size: info.size } : null;
    if (!info?.isDirectory()) return null;
    const files: { rel: string; size: number }[] = [];
    const walk = async (rel: string): Promise<void> => {
      for (const entry of (await readdir(path.join(top, rel))).sort()) {
        const here = path.join(rel, entry);
        const found = await lstat(path.join(top, here));
        if (found.isDirectory()) await walk(here);
        else if (found.isFile() && found.nlink === 1) files.push({ rel: here, size: found.size });
        else throw new ApiError(400, ErrorCode.ValidationFailed, `${here} is a link or not a plain file`);
      }
    };
    await walk('');
    if (files.length === 0) throw new ApiError(400, ErrorCode.ValidationFailed, `${name} holds no files`);
    return { kind: 'dir', size: files.reduce((sum, file) => sum + file.size, 0), files };
  }

  private async plain(sessionId: string, name: string) {
    const info = await lstat(path.join(this.folder(sessionId), name)).catch(() => null);
    return info?.isFile() && info.nlink === 1 ? info : null;
  }

  private async destination(raw: string): Promise<string> {
    const folder = path.resolve(raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw);
    if (!path.isAbsolute(raw) && !raw.startsWith('~/'))
      throw new ApiError(400, ErrorCode.ValidationFailed, 'Give the folder as an absolute path');
    if (
      !(await stat(folder).then(
        (info) => info.isDirectory(),
        () => false,
      ))
    )
      throw new ApiError(404, ErrorCode.NotFound, `No folder ${folder}`);
    await this.refuseClosed(folder);
    return folder;
  }

  /**
   * Folders a save never writes in, whatever the Access mode: sign-in keys, launch agents that start programs, the
   * Keychain and the console's own data folder (ADR 0002, 0003). Compared after links are resolved.
   */
  private async refuseClosed(folder: string): Promise<void> {
    const home = os.homedir();
    const closed = [
      ...['.ssh', '.gnupg', '.aws'].map((name) => path.join(home, name)),
      ...['LaunchAgents', 'LaunchDaemons', 'Keychains'].map((name) => path.join(home, 'Library', name)),
      path.join(home, 'Library', 'Application Support', 'ops-console'),
      // On Linux: the Secret Service's keyrings and the user services and autostart entries that start programs.
      ...(process.platform === 'linux'
        ? [
            ['.local', 'share', 'keyrings'],
            ['.config', 'systemd'],
            ['.config', 'autostart'],
          ].map((parts) => path.join(home, ...parts))
        : []),
      this.dataDir,
    ];
    const real = await realpath(folder);
    for (const root of closed) {
      const resolved = await realpath(root).catch(() => null);
      if (resolved && (real === resolved || real.startsWith(resolved + path.sep)))
        throw new ApiError(
          400,
          ErrorCode.ValidationFailed,
          `${folder} is closed to saves: it holds sign-in keys, startup programs or the console's own data. Nothing was copied.`,
        );
    }
  }
}
