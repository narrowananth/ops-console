import type { Part, RunPurpose, SkillCopy, Subagent, TokenCounts } from '@ops-console/shared';

/** A run in progress. It lives in memory only: a daemon restart ends it (Behavior 18). */
export type Run = {
  sessionId: string;
  /** The in-flight agent message `session.output` streams into. */
  messageId: string;
  accountId: string;
  workingDir: string;
  /** The Playbook rules this run follows; null for none. */
  rules: string | null;
  /** The Skills the run's Playbook holds. */
  skills: SkillCopy[];
  /** True: the agent may use only the held skills. False: the others it can find stay available, as with no Playbook. */
  onlyHeldSkills: boolean;
  /** Tools denied on top of merging. */
  deny: string[];
  /** The run loads the folder's own `.claude` settings, `.mcp.json` and CLAUDE.md; false for a folder that holds pull request code. */
  projectSettings: boolean;
  /** The run may not change its working folder. */
  readOnly: boolean;
  /** What the run is for, kept with its usage. */
  purpose: RunPurpose;
  parts: Part[];
  /** The text part growing from stream deltas, until its block arrives whole. */
  growing: number | null;
  /** Hosts the Run sandbox refused this run, as its commands reported them. */
  blockedHosts: Set<string>;
  /** Part indexes changed since their last `session.output`; sent together once per `OUTPUT_EVERY_MS`. */
  outputDirty: Set<number>;
  /** Fires the next send of `outputDirty`; null when nothing waits. */
  outputTimer: ReturnType<typeof setTimeout> | null;
  /** Transcript entries this run wrote; listing serves them from `parts` instead. */
  sdkUuids: Set<string>;
  /** Action Log row per tool call. */
  toolRows: Map<string, string>;
  /**
   * The agent's text blocks as it wrote them, for the run's summary. Parts split fences out for display, which would
   * cut a JSON answer whose string holds a fenced block of its own.
   */
  said: string[];
  /** Set while the agent waits for the operator's answer to its question. */
  answer: ((text: string) => void) | null;
  /** Approvals the run waits on. */
  waits: number;
  createdAt: string;
  /** Set when the console started the run itself, with no operator message. */
  onFinish: ((summary: RunSummary) => void) | null;
  /** Called with each whole part the agent finishes, in order; set by the code that started the run. */
  onPart: ((part: Part) => void) | null;
  /** How steps name an MCP server, from the Session's kind. */
  serverLabel: ((server: string) => string | null) | null;
  /** Aborts the SDK query when the operator stops the run. */
  abort: AbortController;
  /** Set when the operator stopped the run, so its end reads as stopped, not failed. */
  stopped: boolean;
  /** Set when the operator paused the run: it ends like a stopped one, kept in the tray for Play. */
  paused: boolean;
  /** Set when an Approval or the agent's question waits on the operator: since when (epoch ms). */
  waitingSince: number | null;
  /** Set when the agent moved the Session into a Repo: the next turn starts there once this run ends. */
  joinedRepo: boolean;
  /** The tool-use ids of the `spawn_sessions` calls the operator approved and the tool has not run yet, oldest first. */
  spawnCallIds: string[];
  /** Set when Send now stopped the run: its queued message goes out as the run ends. */
  sendQueuedAfter: boolean;
  /** The subagents the run started, by task id. */
  subagents: Map<string, Subagent>;
  /** The subagent each Task call started: the call's tool use id to the subagent's task id. */
  taskOfToolUse: Map<string, string>;
  /**
   * What each model message used, by message id, not yet saved. A message arrives once per content block with the same
   * id, so a later copy replaces an earlier one instead of adding to it.
   */
  messageUsage: Map<string, { agentId: string | null; model: string; tokens: TokenCounts }>;
  /** When the run began to wait on the usage limit (ISO); null until it does. */
  limitSince: string | null;
  /** The conversation resumes from this transcript entry, dropping what came after it; null for all of it. */
  resumeAt: string | null;
  /** The Network allowlist the run started with; a retry on another account keeps it. */
  networkDomains: string[];
  /** The folders the agent's file tools may write in; set when the run starts. */
  editRoots: string[];
  /** Why the run failed, when the console can say: the Run sandbox is unavailable, or the Keychain did not answer. */
  failure: string | null;
  /** The title the console gave a new Session from its first message; null when the Session was already named. */
  autoTitle: string | null;
};

/** How a run ended, for the code that started it. `stopped` is set when the operator stopped it. */
export type RunSummary = { ok: boolean; stopped: boolean; text: string; failure: string | null };

/** Why a job failed when the operator stopped its run. */
export const STOPPED = 'stopped by the operator';

/** Why a run that did not finish failed, in the words a job shows. */
export const failedBecause = (summary: RunSummary): string =>
  summary.stopped ? STOPPED : (summary.failure ?? 'the agent run failed');

export class RunRegistry {
  private readonly runs = new Map<string, Run>();

  get(sessionId: string): Run | undefined {
    return this.runs.get(sessionId);
  }

  add(run: Run): void {
    this.runs.set(run.sessionId, run);
  }

  remove(sessionId: string): void {
    this.runs.delete(sessionId);
  }

  all(): Run[] {
    return [...this.runs.values()];
  }

  /** The Sessions with a run going. */
  sessionIds(): string[] {
    return [...this.runs.keys()];
  }

  onAccount(accountId: string): boolean {
    return [...this.runs.values()].some((run) => run.accountId === accountId);
  }
}
