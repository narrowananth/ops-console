import { Inject, Injectable } from '@nestjs/common';
import {
  ErrorCode,
  SessionKind,
  type SkillCopy,
  SkillKind,
  type SkillMenu,
  type SkillMenuItem,
  type SkillRef,
} from '@ops-console/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { ApiError } from '../common/errors';
import { repos } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { SkillsService } from '../playbooks/skills.service';
import { readProjectSkills } from './project-skills';
import { SessionKinds } from './session-kinds';
import { type SessionRow, SessionsService } from './sessions.service';
import { SKILL_PLUGIN } from './skill-plugin';

/** A message that names a skill, resolved: what the agent is told, and the copy a console skill hands to the run. */
export type ResolvedSkill = {
  ref: SkillRef;
  /** What the agent gets as the message. */
  prompt: string;
  /**
   * What the run's plugin holds: a Custom skill alone, or a Built-in skill with the rest of its installed pack, so the
   * skills of a pack can call one another. Empty for a Project skill, which Claude Code reads from the Repo.
   */
  copies: SkillCopy[];
};

/** A leading `/name` and the free note after it. */
const TYPED = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/;

/** Project first, then Custom, then Built-in, when a typed name matches several (Behavior 16). */
const PRECEDENCE = [SkillKind.Project, SkillKind.Custom, SkillKind.Builtin] as const;

const byName = (a: SkillMenuItem, b: SkillMenuItem) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
  PRECEDENCE.indexOf(a.kind) - PRECEDENCE.indexOf(b.kind);

/** The `/` menu of a Session, and the skill a message names. */
@Injectable()
export class SkillMenuService {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(SessionKinds) private readonly kinds: SessionKinds,
    @Inject(SkillsService) private readonly skills: SkillsService,
  ) {}

  /**
   * The skills a Session may call, read now. A Repo Session adds the Repo's own skills; an Anonymous Session has none of
   * those; a dev-tools or pull request reply Session has no menu (Behavior 8).
   */
  menu(query: { session_id?: string; repo_id?: string; q?: string }): SkillMenu {
    const { menuAllowed, folder } = this.scope(query.session_id, query.repo_id);
    if (!menuAllowed) return { items: [] };
    const all = this.entries(folder);
    const q = (query.q ?? '').replace(/^\//, '').trim().toLowerCase();
    if (q === '') return { items: all.sort(byName) };
    // A name that starts with the text comes first, then names that hold it, then descriptions that do; each A to Z.
    const starts = all.filter((item) => item.name.toLowerCase().startsWith(q)).sort(byName);
    const holds = all
      .filter((item) => !item.name.toLowerCase().startsWith(q) && item.name.toLowerCase().includes(q))
      .sort(byName);
    const described = all
      .filter((item) => !item.name.toLowerCase().includes(q) && item.description.toLowerCase().includes(q))
      .sort(byName);
    return { items: [...starts, ...holds, ...described] };
  }

  /**
   * The skill a message names, or null when it names none (a plain message runs the Playbook). A skill picked from the
   * menu that is gone throws `skill_not_found`; a typed `/name` that matches none is a plain message (Behavior 16, 18).
   */
  resolve(session: SessionRow, text: string, picked?: SkillRef): ResolvedSkill | null {
    if (session.kind !== SessionKind.Repo && session.kind !== SessionKind.Anonymous) return null;
    const folder = session.kind === SessionKind.Repo ? this.projectFolder(session) : null;
    const typed = TYPED.exec(text);
    if (picked) {
      const found = this.find(picked, folder);
      if (!found) throw new ApiError(404, ErrorCode.SkillNotFound, `no skill named ${picked.name}`);
      const note = typed?.[1] === picked.name ? (typed[2] ?? '').trim() : text.trim();
      return this.build(picked, note, found.copies);
    }
    if (!typed?.[1]) return null;
    for (const kind of PRECEDENCE) {
      const ref = { kind, name: typed[1] };
      const found = this.find(ref, folder);
      if (found) return this.build(ref, (typed[2] ?? '').trim(), found.copies);
    }
    return null;
  }

  private build(ref: SkillRef, note: string, copies: SkillCopy[]): ResolvedSkill {
    const skill = ref.kind === SkillKind.Project ? ref.name : `${SKILL_PLUGIN}:${ref.name}`;
    const prompt = `Use the "${skill}" skill for this task.${note === '' ? '' : `\n\n${note}`}`;
    return { ref, prompt, copies };
  }

  /** The skills the run holds when the skill exists, else false. */
  private find(ref: SkillRef, folder: string | null): { copies: SkillCopy[] } | false {
    if (ref.kind === SkillKind.Project) {
      return folder !== null && readProjectSkills(folder).some((skill) => skill.name === ref.name)
        ? { copies: [] }
        : false;
    }
    if (ref.kind === SkillKind.Custom) {
      const copy = this.skills.customNamed(ref.name);
      return copy ? { copies: [copy] } : false;
    }
    const builtin = this.skills.builtinNamed(ref.name);
    return builtin ? { copies: this.skills.packCopies(builtin.pack.id) } : false;
  }

  private entries(folder: string | null): SkillMenuItem[] {
    const project =
      folder === null
        ? []
        : readProjectSkills(folder).map((skill) => ({ kind: SkillKind.Project, ...skill, pack: null }));
    return [...this.skills.menuEntries(), ...project];
  }

  private scope(sessionId?: string, repoId?: string): { menuAllowed: boolean; folder: string | null } {
    if (sessionId !== undefined) {
      const session = this.sessions.get(sessionId);
      if (session.kind !== SessionKind.Repo && session.kind !== SessionKind.Anonymous) {
        return { menuAllowed: false, folder: null };
      }
      return { menuAllowed: true, folder: session.kind === SessionKind.Repo ? this.projectFolder(session) : null };
    }
    if (repoId !== undefined) {
      const repo = this.store.db
        .select({ path: repos.path })
        .from(repos)
        .where(and(eq(repos.id, repoId), isNull(repos.removedAt)))
        .get();
      if (!repo) throw new ApiError(404, ErrorCode.NotFound, 'no such Repo');
      return { menuAllowed: true, folder: repo.path };
    }
    return { menuAllowed: true, folder: null };
  }

  private projectFolder(session: SessionRow): string | null {
    return this.kinds.get(session.kind)?.workingDir(session) ?? null;
  }
}
