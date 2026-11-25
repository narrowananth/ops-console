import { type PlaybookStep, PrAction, type SkillCopy } from '@ops-console/shared';
import { PR_ACTION_TOOLS } from '../agent/pull-request-tool';
import type { HostComment, HostPullRequest } from './git-host';
import { fileLine, threadText } from './pr-host-writes';

/** What a PR action Session takes from its Trigger's Playbook: the rules, the Skills and the steps. */
export type PlaybookText = { rules: string; skills: SkillCopy[]; steps: PlaybookStep[] };

/** The Playbook as prompt text: its rules, its Skills, then each step's title as a heading over its text, in order. */
export function playbookText({ rules, skills, steps }: PlaybookText): string {
  const parts: string[] = [];
  if (rules.trim()) parts.push(`The operator's rules for this work:\n${rules.trim()}`);
  if (skills.length > 0) {
    parts.push(
      `Skills the operator gave you for this work:\n${skills.map((skill) => `## ${skill.name}\n${skill.instructions.trim()}`).join('\n\n')}`,
    );
  }
  if (steps.length > 0) {
    parts.push(
      `Work through these steps in order, in this one turn:\n\n${steps.map((step) => `## ${step.title}\n${step.instructions.trim()}`).join('\n\n')}`,
    );
  }
  return parts.join('\n\n');
}

const listed = (threads: HostComment[][]) =>
  threads
    .map((thread) => {
      const root = thread[0] as HostComment;
      return `[comment_id ${root.id}] on ${fileLine(root)}:\n${threadText(thread)}`;
    })
    .join('\n\n');

/** The pull request and the threads Address comments covers; each is a change request, as the console safety rules say. */
export function addressBrief(slug: string, pr: HostPullRequest, threads: HostComment[][]): string {
  return `Address review comments on pull request #${pr.number} of ${slug}: "${pr.title}", ${pr.branch} into ${pr.base_branch}, at head commit ${pr.head_sha}. This folder is a worktree at that commit: change code only here.

The operator ticked these threads. Each one is a change request, as the console safety rules say:

${listed(threads)}`;
}

/** The pull request and the replied threads Check replies covers. */
export function checkBrief(slug: string, pr: HostPullRequest, threads: HostComment[][]): string {
  return `Check the replies in review threads on pull request #${pr.number} of ${slug}: "${pr.title}" by ${pr.author}, ${pr.branch} into ${pr.base_branch}, at head commit ${pr.head_sha}. This folder is a worktree at that commit. Change nothing that matters: the console keeps none of it.

Each thread below has a reply after its comment. For each one, decide whether the code at the head commit does what the thread asked:

${listed(threads)}`;
}

/** How the Session ends: the one tool whose call the console turns into commits, replies and resolves. */
const FINISH: Record<PrAction, string> = {
  [PrAction.AddressComments]: `When the work is done, call ${PR_ACTION_TOOLS[PrAction.AddressComments]} once with every ticked thread, each done or declined, with a reply. A thread that needs the author's answer, or more work than this Session can do, is declined: put the question or the reason in the reply. Do not commit, push or post comments yourself: the console commits what is in this folder, pushes it, and posts your replies. You may commit if you need to run the repository's checks; the console keeps those commits.`,
  [PrAction.CheckReplies]: `When you have checked every thread, call ${PR_ACTION_TOOLS[PrAction.CheckReplies]} once with a verdict (fixed, partly_fixed or not_fixed) and a reply for each. Do not post comments yourself: the console posts your replies and resolves the fixed threads.`,
  [PrAction.Review]: '',
};

/** Said to the agent when a Round starts in a Session that has had one: what carries over and what does not. */
const NEXT_ROUND = `This is a new Round in this Session. Your earlier Rounds are over: results you did not submit are dropped, and only this Round's tool call posts anything. The worktree is now at the head commit below, with any uncommitted changes you left in it. Use what you learned earlier.`;

/** The Round's first message: the brief, the Playbook, and how to finish. A later Round says so first. */
export function openingPrompt(
  action: PrAction,
  brief: string,
  playbook: PlaybookText,
  guide = '',
  later = false,
): string {
  return [later ? NEXT_ROUND : '', brief, playbookText(playbook), guide, FINISH[action]]
    .filter((part) => part.trim())
    .join('\n\n');
}

/** How a Round's action reads to the agent. */
export const ROUND_NAME: Record<PrAction, string> = {
  [PrAction.AddressComments]: 'Address comments',
  [PrAction.CheckReplies]: 'Check replies',
  [PrAction.Review]: 'Agent Review',
};

/** The PR Session's title: the pull request, whatever Round it is in. */
export const prSessionTitle = (number: number) => `Pull request #${number}`;
