import { createReadStream, createWriteStream, existsSync, type ReadStream, statSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import { type Attachment, ErrorCode } from '@ops-console/shared';
import { DATA_DIR } from '../common/data-dir';
import { ApiError } from '../common/errors';

/** A saved file's name: the id it was saved under and the operator's extension. */
const SAVED = /^[0-9a-f-]{36}(\.[A-Za-z0-9]{1,16})?$/;

/** How the console shows a file: images, PDFs, video and audio as themselves, text as text, the rest as bytes. */
const TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};
const TEXT = new Set([
  '.conf',
  '.css',
  '.csv',
  '.diff',
  '.go',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsonl',
  '.jsx',
  '.kt',
  '.log',
  '.md',
  '.mjs',
  '.patch',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.tsv',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

/** The media type the agent is told for a file, from its extension. A label only: nothing is served with it. */
const MEDIA_TYPES: Record<string, string> = {
  '.7z': 'application/x-7z-compressed',
  '.avi': 'video/x-msvideo',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.flac': 'audio/flac',
  '.gz': 'application/gzip',
  '.heic': 'image/heic',
  '.html': 'text/html',
  '.json': 'application/json',
  '.key': 'application/vnd.apple.keynote',
  '.m4v': 'video/x-m4v',
  '.md': 'text/markdown',
  '.mkv': 'video/x-matroska',
  '.numbers': 'application/vnd.apple.numbers',
  '.pages': 'application/vnd.apple.pages',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rtf': 'application/rtf',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.tgz': 'application/gzip',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
};

/** The type a message tells the agent for a file: a known extension, else plain text for text, else bytes. */
export function mediaType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return MEDIA_TYPES[ext] ?? TYPES[ext] ?? (TEXT.has(ext) ? 'text/plain' : 'application/octet-stream');
}

/** The type a file is served with: never one a browser renders as a page or runs (HTML, SVG). The viewer shows those in a sandbox. */
export function fileType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return TYPES[ext] ?? (TEXT.has(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
}

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
    const { size } = await stat(file);
    if (size === 0) {
      await rm(file);
      throw new ApiError(400, ErrorCode.ValidationFailed, `${shown} is empty: nothing to attach`);
    }
    return { name: shown, path: file, size, type: mediaType(shown) };
  }

  /** A saved file of the Session's, to show the operator; a name not saved here is `not_found`. */
  read(sessionId: string, file: string): { stream: ReadStream; type: string; size: number } {
    const full = path.join(this.folder(sessionId), file);
    if (!SAVED.test(file) || !existsSync(full)) throw new ApiError(404, ErrorCode.NotFound, 'No such attached file');
    return { stream: createReadStream(full), type: fileType(file), size: statSync(full).size };
  }
}
