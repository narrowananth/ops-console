import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SkillCopy } from '@ops-console/shared';

/** The plugin a run loads its Skills from. Claude Code names a plugin's skills `<plugin>:<skill>`. */
export const SKILL_PLUGIN = 'ops-console-skills';

/** Where a run's Skill folders live: the temp folder, which the operating system clears, outside the data folder. */
export const skillRunsDir = (): string => path.join(tmpdir(), 'ops-console-skills');

/** A Skill's name as the SDK and Claude Code write it, `<plugin>:<name>`, back to the name the operator gave it. */
export const skillNameOf = (qualified: string): string => qualified.replace(/^[^:]+:/, '');

/** The names the SDK's `skills` option takes for these Skills. */
export const skillNames = (skills: SkillCopy[]): string[] => skills.map((skill) => `${SKILL_PLUGIN}:${skill.name}`);

/**
 * Writes the Skills as a local Claude Code plugin: a manifest and one `SKILL.md` per Skill. JSON strings are valid YAML
 * scalars, so the description needs no escaping of its own.
 */
export async function writeSkillPlugin(folder: string, skills: SkillCopy[]): Promise<void> {
  await mkdir(path.join(folder, '.claude-plugin'), { recursive: true });
  await writeFile(
    path.join(folder, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: SKILL_PLUGIN, version: '1.0.0', description: "The Skills of this run's Playbook" }),
    { mode: 0o600 },
  );
  for (const skill of skills) {
    const dir = path.join(folder, 'skills', skill.name);
    await mkdir(dir, { recursive: true });
    const text = `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`;
    await writeFile(path.join(dir, 'SKILL.md'), text, { mode: 0o600 });
  }
}

/** Cleanup never hides why a run failed: a folder that cannot be removed stays in the temp folder. */
export const removeSkillPlugin = (folder: string): Promise<void> =>
  rm(folder, { recursive: true, force: true }).catch(() => {});
