import { FILE_TOKEN } from '@ops-console/shared';

/**
 * `$skill` and `@file` mentions and `[📎 name]` attached files: how they read in a message the agent gets, and how the
 * console draws them as chips. The text is the only truth; a chip is how the console shows it.
 */

/** A mention in a message: at the start or after whitespace. `$name`, `@"a path with spaces"` or `@path/to.file`. */
export const MENTION = /(^|\s)(\$[a-z][a-z0-9:_-]*|@"[^"\n]+"|@(?=[^\s"]*[/.])[^\s"]+)/g;

/** What a mention menu is open for: the trigger character and the letters typed after it. */
export type Token = { trigger: '$' | '@' | '/'; query: string; text: string; key: string };

/** The `@` text for a path as the agent reads it: quoted when it holds a space. */
export const filePath = (path: string) => (/\s/.test(path) ? `@"${path}"` : `@${path}`);

/** `code-review` as `Code Review`, `caveman:cavecrew` as `Caveman Cavecrew`. */
export const skillLabel = (name: string) =>
  name
    .split(/[:_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/** What a chip shows for a mention's text: the skill's name, or the file's own name with its path in the tip. */
export function describeMention(raw: string): {
  kind: 'skill' | 'file' | 'attachment';
  label: string;
  title: string;
  badge: string;
} {
  const attached = ATTACHED_RAW.exec(raw)?.[1];
  if (attached !== undefined) {
    const ext = attached.includes('.') ? (attached.split('.').at(-1) ?? '') : '';
    return {
      kind: 'attachment',
      label: attached,
      title: `Attached file ${attached}`,
      badge: ext.slice(0, 4).toUpperCase(),
    };
  }
  if (raw.startsWith('$')) return { kind: 'skill', label: skillLabel(raw.slice(1)), title: raw, badge: '' };
  const path = raw.startsWith('@"') ? raw.slice(2, -1) : raw.slice(1);
  const name = path.split('/').filter(Boolean).at(-1) ?? path;
  const ext = name.includes('.') ? (name.split('.').at(-1) ?? '') : '';
  return { kind: 'file', label: name, title: path, badge: ext.slice(0, 4).toUpperCase() };
}

const ATTACHED_RAW = /^\[📎 ([^\]\n]+)\]$/;

/** An attached file's name when `raw` is its `[📎 name]` token; null for any other mention. */
export const attachedName = (raw: string): string | null => ATTACHED_RAW.exec(raw)?.[1] ?? null;

/** Every chip in `text`, in order: the `[📎 name]` tokens, and the `$` and `@` mentions around them. */
export function chipsIn(text: string): { raw: string; start: number; end: number }[] {
  const found: { raw: string; start: number; end: number }[] = [];
  let at = 0;
  for (const token of text.matchAll(FILE_TOKEN)) {
    const start = token.index ?? 0;
    for (const one of mentionsIn(text.slice(at, start)))
      found.push({ raw: one.raw, start: one.start + at, end: one.end + at });
    found.push({ raw: token[0], start, end: start + token[0].length });
    at = start + token[0].length;
  }
  for (const one of mentionsIn(text.slice(at))) found.push({ raw: one.raw, start: one.start + at, end: one.end + at });
  return found;
}

/** The mentions in `text`, with where each starts and ends. */
export function mentionsIn(text: string): { raw: string; start: number; end: number }[] {
  return [...text.matchAll(MENTION)].map((match) => {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const raw = match[2] ?? '';
    return { raw, start, end: start + raw.length };
  });
}

/** The cube drawn on a skill chip, as path data in a 24px box. */
export const CUBE_PATH = 'M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Zm-8 4.5 8 4.5m0 0 8-4.5M12 12v9';

const BASE =
  'mx-0.5 inline-flex max-w-72 items-center gap-1 rounded-md border px-1.5 align-baseline text-[0.93em] leading-6';
/** The classes of a chip: the editor builds its chips as DOM, the conversation as React, and both read these. */
export const CHIP_CLASS = {
  skill: `${BASE} border-skill/30 bg-skill/10 text-skill`,
  file: `${BASE} border-line bg-neutral-200/60 text-text`,
  attachment: `${BASE} cursor-pointer border-line bg-neutral-200/60 text-text`,
  badge:
    'flex-none rounded-sm bg-neutral-300/70 px-1 text-[10px] leading-4 font-semibold text-neutral-800 before:content-[attr(data-badge)]',
} as const;
