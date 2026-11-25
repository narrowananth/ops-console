import { type Cell, type Part } from '@ops-console/shared';
import { z } from 'zod';

export type ParsedJson = { ok: true; value: unknown } | { ok: false; message: string; line: number };

/** The line of a character offset, counting from 1. */
const lineAt = (text: string, offset: number) => text.slice(0, offset).split('\n').length;

const reason = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

/**
 * The length of the shortest prefix the engine refuses for a reason other than running out of text. Some messages name
 * no position, so the prefix that first breaks it says where.
 */
function brokenAt(text: string): number {
  const refused = (length: number) => {
    try {
      JSON.parse(text.slice(0, length));
      return false;
    } catch (failure) {
      const position = /position (\d+)/.exec(reason(failure));
      return position ? Number(position[1]) < length : !/end of JSON/.test(reason(failure));
    }
  };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (refused(middle)) high = middle;
    else low = middle + 1;
  }
  return high;
}

/** The line a parse failed on: the engine's own, else the one holding the character that broke it. */
function failedLine(text: string, message: string): number {
  const named = /\(line (\d+) column \d+\)/.exec(message);
  if (named) return Number(named[1]);
  const position = /position (\d+)/.exec(message);
  return lineAt(text, Math.min(position ? Number(position[1]) + 1 : brokenAt(text), text.trimEnd().length));
}

/** JSON text as a value; with `lines`, JSON Lines as a list holding one value per non-blank line. */
export function parseJson(text: string, lines: boolean): ParsedJson {
  if (!lines) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (failure) {
      return { ok: false, message: reason(failure), line: failedLine(text, reason(failure)) };
    }
  }
  const values: unknown[] = [];
  const all = text.split('\n');
  for (const [at, line] of all.entries()) {
    if (line.trim() === '') continue;
    try {
      values.push(JSON.parse(line));
    } catch (failure) {
      return { ok: false, message: reason(failure), line: at + 1 };
    }
  }
  return { ok: true, value: values };
}

const resultSchema = z.object({
  connection: z.string(),
  query: z.string().nullish(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  total: z.number().nullish(),
  ms: z.number().nullish(),
});

const cell = (value: unknown): Cell =>
  value === null || value === undefined
    ? null
    : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? value
      : JSON.stringify(value);

/** One `ops-result` object as the part the Dev tools Result table draws; null for any other value. */
export function asOpsResult(value: unknown): Extract<Part, { kind: 'result' }> | null {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return null;
  const { connection, query, columns, rows, total, ms } = parsed.data;
  return {
    kind: 'result',
    connection,
    query: query ?? null,
    columns,
    rows: rows.map((row) => row.map(cell)),
    total: total ?? null,
    ms: ms ?? null,
  };
}
