import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import type { Attachment } from '@ops-console/shared';
import { DATA_DIR } from '../common/data-dir';

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
}
