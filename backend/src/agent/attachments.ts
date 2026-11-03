import { createReadStream, createWriteStream, existsSync, type ReadStream, statSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import { type Attachment, ErrorCode } from '@ops-console/shared';
import { DATA_DIR } from '../common/data-dir';
import { ApiError } from '../common/errors';

/** A saved file's name: the id it was saved under and the operator's extension. */
const SAVED = /^[0-9a-f-]{36}(\.[A-Za-z0-9]{1,16})?$/;

/** How the console shows a file: images and PDFs as themselves, text as text, the rest as bytes to download. */
const TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const TEXT = new Set(['.csv', '.json', '.log', '.md', '.sql', '.txt', '.xml', '.yaml', '.yml']);

/**
 * Files the operator attaches to a Session's messages, one folder per Session under the data folder. The agent reads
 * them by path; each is saved under a new name, so the operator's file name never picks where it goes.
 */
@Injectable()
export class Attachments {
  constructor(@Inject(DATA_DIR) private readonly dataDir: string) {}

  folder(sessionId: string): string {
    return path.join(this.dataDir, 'attachments', sessionId);
  }

  /** The Session's folder when it has attachments; a run lets the agent read there. */
  existingFolder(sessionId: string): string | null {
    const folder = this.folder(sessionId);
    return existsSync(folder) ? folder : null;
  }

  async save(sessionId: string, name: string, body: Readable): Promise<Attachment> {
    const folder = this.folder(sessionId);
    await mkdir(folder, { recursive: true });
    const shown = path.basename(name);
    const file = path.join(folder, `${crypto.randomUUID()}${path.extname(shown)}`);
    await pipeline(body, createWriteStream(file));
    return { name: shown, path: file, size: (await stat(file)).size };
  }

  /** A saved file of the Session's, to show the operator; a name not saved here is `not_found`. */
  read(sessionId: string, file: string): { stream: ReadStream; type: string; size: number } {
    const full = path.join(this.folder(sessionId), file);
    if (!SAVED.test(file) || !existsSync(full)) throw new ApiError(404, ErrorCode.NotFound, 'No such attached file');
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext] ?? (TEXT.has(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    return { stream: createReadStream(full), type, size: statSync(full).size };
  }
}
