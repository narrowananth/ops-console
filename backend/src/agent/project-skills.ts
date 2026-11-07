import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { SKILL_LIMITS } from '@ops-console/shared';

/** A skill in a Repo's own folder: one `.claude/skills/<folder>/SKILL.md` whose header names and describes it. */
export type ProjectSkill = { name: string; description: string };

const NAME = /^[a-z0-9-]+$/;
const MAX_HEADER_BYTES = 16 * 1024;

/** `key: value` lines of a SKILL.md header, folded (`>`) and literal (`|`) values joined. */
function header(text: string): Map<string, string> {
  const found = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields = new Map<string, string>();
  if (!found?.[1]) return fields;
  const lines = found[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] ?? '');
    if (!match?.[1]) continue;
    let value = (match[2] ?? '').trim();
    if (/^[>|][+-]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? '')) parts.push((lines[++i] ?? '').trim());
      value = parts.join(' ');
    } else if (value.length >= 2 && /^["'].*["']$/.test(value)) {
      value = value.slice(1, -1);
    }
    fields.set(match[1], value);
  }
  return fields;
}

/** The first bytes of a file, enough for its header. */
function readHead(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, MAX_HEADER_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * The skills in a Repo's working folder, A to Z. A folder with no `SKILL.md`, no valid name or no description is
 * skipped, never listed (Behavior 12). Reads only the header.
 */
export function readProjectSkills(folder: string): ProjectSkill[] {
  const root = path.join(folder, '.claude', 'skills');
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const found: ProjectSkill[] = [];
  for (const entry of entries) {
    const file = path.join(root, entry, 'SKILL.md');
    try {
      if (!statSync(file).isFile()) continue;
      const fields = header(readHead(file));
      const name = fields.get('name');
      const description = fields.get('description');
      if (!name || !NAME.test(name) || name.length > SKILL_LIMITS.name || !description) continue;
      found.push({ name, description: description.slice(0, SKILL_LIMITS.description) });
    } catch {}
  }
  return found.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
