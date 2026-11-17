import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
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

/** The skill a SKILL.md head describes, or null when its name or description is missing or invalid. */
function skillOf(head: string): ProjectSkill | null {
  const fields = header(head);
  const name = fields.get('name');
  const description = fields.get('description');
  if (!name || !NAME.test(name) || name.length > SKILL_LIMITS.name || !description) return null;
  return { name, description: description.slice(0, SKILL_LIMITS.description) };
}

const byName = (a: ProjectSkill, b: ProjectSkill) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

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
      const skill = skillOf(readHead(file));
      if (skill) found.push(skill);
    } catch {}
  }
  return found.sort(byName);
}

/** `readProjectSkills` without holding the daemon's thread on the disk. */
export async function readProjectSkillsAsync(folder: string): Promise<ProjectSkill[]> {
  const root = path.join(folder, '.claude', 'skills');
  const entries = await readdir(root).catch(() => []);
  const read = async (entry: string): Promise<ProjectSkill | null> => {
    const file = path.join(root, entry, 'SKILL.md');
    try {
      if (!(await stat(file)).isFile()) return null;
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(MAX_HEADER_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, MAX_HEADER_BYTES, 0);
        return skillOf(buffer.toString('utf8', 0, bytesRead));
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  };
  const skills = await Promise.all(entries.map(read));
  return skills.filter((skill): skill is ProjectSkill => skill !== null).sort(byName);
}
