import { constants, mkdirSync, type ReadStream } from 'node:fs';
import { type FileHandle, lstat, open, readdir, rm, stat } from 'node:fs/promises';
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
  /** A file name in the Session's output folder. */
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
 * Files the agent writes for the operator: one folder per Session under the data folder, which the Run sandbox lets
 * the run write and read. The daemon serves only plain files in it, by bare name, and copies one elsewhere only after
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
    const found = bare(input.name) ? await this.plain(sessionId, input.name) : null;
    if (!found) throw new ApiError(404, ErrorCode.NotFound, `No file ${input.name} in your output folder`);
    const folder = await this.destination(input.folder);
    return `Save ${input.name} (${bytes(found.size)}) to ${folder}${path.sep}`;
  }

  async save(sessionId: string, input: SaveFileInput): Promise<string> {
    await this.describe(sessionId, input);
    const to = path.join(await this.destination(input.folder), input.name);
    const source = await this.openPlain(sessionId, input.name);
    if (!source) throw notFound();
    // The agent writes in the source folder and may write in the destination: neither end follows a symlink.
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
    const target = await open(to, flags).catch(() => null);
    if (!target) {
      await source.handle.close();
      throw new ApiError(400, ErrorCode.ValidationFailed, `Cannot write ${to}`);
    }
    await pipeline(source.handle.createReadStream(), target.createWriteStream());
    return to;
  }

  /**
   * Opens a plain file of the folder, never through a symlink, and checks the open file itself: the agent can swap a
   * name for a link between a check and a read. A file with another hard link is refused, since a link to a file the
   * sandbox hides would read through this folder.
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
    return folder;
  }
}
