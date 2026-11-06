import {
  type Failure,
  FailureKind,
  lanesOf,
  PHASE_ORDER,
  RunHealth,
  RunOutcome,
  RunPhase,
  type RunPhaseStep,
  SessionKind,
  type SlowDiagnosis,
  type Subagent,
  SubagentStatus,
  type TimedStep,
} from '@ops-console/shared';

/** One tool call of a run, as the page reads it. Times are epoch milliseconds. */
export type StepFacts = {
  id: string;
  agentId: string | null;
  tool: string;
  summary: string;
  phase: RunPhase;
  startedAt: number;
  finishedAt: number | null;
  waitedMs: number;
  ok: boolean | null;
  error: string | null;
};

const READING = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead']);
const EDITING = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Where a tool call's time goes. MCP tools, Skills and subagent calls count as commands and tools. */
export function phaseOf(tool: string): RunPhase {
  if (READING.has(tool)) return RunPhase.Reading;
  if (EDITING.has(tool)) return RunPhase.Editing;
  return RunPhase.Commands;
}

/** A command is the same command when its first two words match: `pnpm test`, `git status`. */
export function commandKey(summary: string): string | null {
  if (!summary.startsWith('$ ')) return null;
  const words = summary
    .slice(2)
    .trim()
    .split(/\s+/)
    .filter((word) => !/^[A-Z_][A-Z0-9_]*=/.test(word));
  return words.slice(0, 2).join(' ') || null;
}

/** How long past runs of each command took, from the steps that ended. */
export type History = Map<string, number[]>;

export function historyOf(steps: StepFacts[]): History {
  const history: History = new Map();
  for (const step of steps) {
    const key = commandKey(step.summary);
    if (key === null || step.finishedAt === null || step.ok === null) continue;
    const took = step.finishedAt - step.startedAt - step.waitedMs;
    if (took < 0) continue;
    history.set(key, [...(history.get(key) ?? []), took]);
  }
  return history;
}

const MIN_SAMPLES = 3;

/** The middle time of a command's earlier runs; null until the console has seen it a few times. */
export function usualMs(history: History, summary: string): number | null {
  const key = commandKey(summary);
  const times = key === null ? undefined : history.get(key);
  if (!times || times.length < MIN_SAMPLES) return null;
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/** A step is slow past this when the console has no history for it, and past 3 times the usual otherwise. */
const SLOW_UNKNOWN_MS = 5 * 60_000;
const SLOW_FLOOR_MS = 2 * 60_000;

export function slowAfterMs(usual: number | null): number {
  return usual === null ? SLOW_UNKNOWN_MS : Math.max(SLOW_FLOOR_MS, usual * 3);
}

export function fmtMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** The step the main agent waits on now: the newest one still open. */
export function openStep(steps: StepFacts[]): StepFacts | null {
  return steps.findLast((step) => step.finishedAt === null && step.agentId === null) ?? null;
}

/** The longest open step of any agent, with how long it has gone without the time it waited on the operator. */
function slowest(steps: StepFacts[], now: number): { step: StepFacts; ran: number } | null {
  let found: { step: StepFacts; ran: number } | null = null;
  for (const step of steps) {
    if (step.finishedAt !== null) continue;
    const ran = now - step.startedAt - step.waitedMs;
    if (found === null || ran > found.ran) found = { step, ran };
  }
  return found;
}

const shown = (summary: string) => (summary.startsWith('$ ') ? summary.slice(2) : summary);

export type HealthInput = {
  running: boolean;
  /** The agent waits for an Approval or an answer; since when, and on what. */
  waiting: { since: number; on: string } | null;
  outcome: RunOutcome | null;
  steps: StepFacts[];
  history: History;
  now: number;
  /** The failure the page would show for an ended run, for its one-line reason. */
  failure: Failure | null;
};

/** Whether to look at a run, and in one line why. */
export function healthOf(input: HealthInput): { health: RunHealth; reason: string } {
  const { running, waiting, outcome, now } = input;
  if (running) {
    if (waiting) {
      return {
        health: RunHealth.NeedsYou,
        reason: `Waiting on you for ${fmtMs(now - waiting.since)}${waiting.on ? `: ${waiting.on}` : ''}`,
      };
    }
    const long = slowest(input.steps, now);
    if (long) {
      const usual = usualMs(input.history, long.step.summary);
      if (long.ran > slowAfterMs(usual)) {
        return {
          health: RunHealth.Slow,
          reason: `Slow: ${shown(long.step.summary)} running ${fmtMs(long.ran)}${usual === null ? '' : `, usual ${fmtMs(usual)}`}`,
        };
      }
    }
    const step = openStep(input.steps);
    return {
      health: RunHealth.OnTrack,
      reason: step ? `On track: ${activityOf(step)}` : 'On track: the agent is thinking',
    };
  }
  if (outcome === RunOutcome.Stopped) return { health: RunHealth.Stopped, reason: 'Stopped by you. Play carries on.' };
  if (outcome === RunOutcome.Paused) return { health: RunHealth.Stopped, reason: 'Paused by you. Play carries on.' };
  return {
    health: RunHealth.Failed,
    reason: input.failure ? `Failed: ${input.failure.what_happened}` : 'The run ended with an error.',
  };
}

/** What the agent does in one open step, in words. */
export function activityOf(step: StepFacts): string {
  if (step.summary.startsWith('$ ')) return `Running ${shown(step.summary)}`;
  if (step.tool === 'Agent' || step.tool === 'Task')
    return `Working with a subagent: ${step.summary.replace(/^\S+\s*/, '')}`;
  if (READING.has(step.tool)) return `Reading ${step.summary.replace(/^\S+\s*/, '')}`.trim();
  if (EDITING.has(step.tool)) return `Editing ${step.summary.replace(/^\S+\s*/, '')}`.trim();
  return step.summary;
}

const NETWORK_COMMAND =
  /\b(curl|wget|npm|pnpm|yarn|npx|pip3?|uv|cargo|go\s+(get|mod|install)|git\s+(fetch|clone|pull|ls-remote)|mvn|gradle|docker|gh|brew)\b/;
const TEST_COMMAND = /\b(test|tests|jest|vitest|pytest|mocha|playwright|cypress|spec|check)\b/;

const hostOf = (text: string): string | null => {
  const url = /https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/i.exec(text);
  if (url?.[1]) return url[1].toLowerCase();
  const named =
    /(?:Could not resolve host:|getaddrinfo (?:ENOTFOUND|EAI_AGAIN))\s+([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/i.exec(text);
  return named?.[1]?.toLowerCase() ?? null;
};

/** Why a step has gone on so long, as far as its command lets the console tell. Never says what the agent thinks. */
export function diagnoseSlow(input: {
  steps: StepFacts[];
  history: History;
  now: number;
  queued: boolean;
}): SlowDiagnosis | null {
  const long = slowest(input.steps, input.now);
  if (!long) return null;
  const { step, ran } = long;
  const usual = usualMs(input.history, step.summary);
  const command = shown(step.summary);
  const network = step.summary.startsWith('$ ') && NETWORK_COMMAND.test(command);
  const test = step.summary.startsWith('$ ') && TEST_COMMAND.test(command);
  const host = step.summary.startsWith('$ ') ? hostOf(command) : null;
  return {
    right_now: `${command} has run ${fmtMs(ran)}. ${
      usual === null
        ? 'The console has not seen this command often enough to say how long it usually takes.'
        : `It usually takes ${fmtMs(usual)}.`
    }`,
    likely_cause: network
      ? 'The command reaches the network. The Run sandbox lets a command reach listed hosts only, so a call to another host can wait until it times out.'
      : test
        ? 'A test may be waiting on something that does not answer, such as a host the Run sandbox does not allow. The console cannot see the command output, so it cannot say which.'
        : 'The console cannot see what this step waits on.',
    also: input.queued ? 'A message is queued behind this run. It sends when the run ends.' : null,
    suggestion:
      network || test
        ? 'Stop the run and tell the agent to mock the call, or allow the host in the Network allowlist.'
        : 'If this is longer than you expect, stop the run and tell the agent what to do instead.',
    blocked_host: host,
  };
}

const NETWORK_ERROR =
  /(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|Could not resolve host|Connection refused|network is unreachable|FETCH_403|403 Forbidden|blocked by|proxy)/i;
const WRITE_ERROR = /(Operation not permitted|EPERM|EACCES|read-only file system|Permission denied)/i;
const HOOK_ERROR = /(husky|pre-commit|lint-staged|lefthook|commit hook|hook failed|pre-push)/i;

/** The failed step an ended run's error is read from: the last call that did not work. */
export function lastFailedStep(steps: StepFacts[]): StepFacts | null {
  return steps.findLast((step) => step.ok === false && step.error !== 'stopped' && step.error !== 'no result') ?? null;
}

/** What happened, the likely cause and what to do for a run that ended badly. Words are plain; the raw error stays under them. */
export function classifyFailure(input: {
  outcome: RunOutcome | null;
  lastError: string | null;
  steps: StepFacts[];
  /** The run's subagents, for what a Retry resumes at. */
  subagents?: Subagent[];
  /** When the account's usage window resets (ISO), when the SDK said. */
  resetsAt?: string | null;
}): Failure | null {
  const { outcome } = input;
  if (
    outcome === null ||
    outcome === RunOutcome.Done ||
    outcome === RunOutcome.Stopped ||
    outcome === RunOutcome.Paused
  ) {
    return null;
  }
  const resume_point = resumePointOf(input.steps, input.subagents ?? []);
  const none = { raw: null, blocked_host: null, resets_at: null, resume_point };
  if (outcome === RunOutcome.RateLimited) {
    return {
      kind: FailureKind.RateLimited,
      what_happened: 'The Claude account hit its usage limit.',
      likely_cause: 'The account used up its usage window. Longer runs and larger models use it fastest.',
      what_to_do:
        'Switch to another account in Agents & accounts, or Retry after the limit resets. Work so far stays in the Session.',
      ...none,
      raw: input.lastError,
      resets_at: input.resetsAt ?? null,
    };
  }
  if (outcome === RunOutcome.SignedOut) {
    return {
      kind: FailureKind.SignedOut,
      what_happened: 'The Claude sign-in stopped working.',
      likely_cause: 'The login expired and could not refresh.',
      what_to_do: 'Sign in again in Agents & accounts, then Retry.',
      ...none,
      raw: input.lastError,
    };
  }
  if (outcome === RunOutcome.Interrupted) {
    return {
      kind: FailureKind.Interrupted,
      what_happened: 'The console restarted while the run went.',
      likely_cause: 'A run does not survive a restart of the daemon.',
      what_to_do: 'Retry. The agent carries on from the conversation.',
      ...none,
    };
  }
  const step = lastFailedStep(input.steps);
  const text = [step?.error, input.lastError].filter(Boolean).join('\n');
  const raw = text === '' ? null : text.slice(0, 500);
  const doing = step
    ? `The agent ran ${step.summary.startsWith('$ ') ? `\`${step.summary.slice(2)}\`` : step.summary} and it failed.`
    : 'The run ended with an error.';
  if (step?.summary.startsWith('$ ') && /\bgit\s+(commit|push)\b/.test(step.summary) && HOOK_ERROR.test(text)) {
    return {
      kind: FailureKind.HookFailed,
      what_happened: 'A commit hook failed.',
      likely_cause: 'The repo runs checks on commit and one of them reported a problem.',
      what_to_do: 'Fix what the hook reports and commit again. The console does not skip hooks. Retry carries on.',
      blocked_host: null,
      raw,
      resets_at: null,
      resume_point,
    };
  }
  if (NETWORK_ERROR.test(text)) {
    const host = hostOf(text) ?? (step ? hostOf(step.summary) : null);
    return {
      kind: FailureKind.NetworkBlocked,
      what_happened: doing,
      likely_cause: host
        ? `The Run sandbox lets a command reach listed hosts only. ${host} is probably not on the list.`
        : 'The Run sandbox lets a command reach listed hosts only. The host it called is probably not on the list.',
      what_to_do: host
        ? `Allow ${host} in the Network allowlist, then Retry. The agent carries on from the conversation.`
        : 'Allow the host in the Network allowlist, then Retry.',
      blocked_host: host,
      raw,
      resets_at: null,
      resume_point,
    };
  }
  if (WRITE_ERROR.test(text)) {
    return {
      kind: FailureKind.WriteBlocked,
      what_happened: doing,
      likely_cause: 'The Run sandbox lets a command write in the working folder and the tool caches only.',
      what_to_do: 'Tell the agent to write inside the working folder, then Retry.',
      blocked_host: null,
      raw,
      resets_at: null,
      resume_point,
    };
  }
  return {
    kind: FailureKind.Unknown,
    what_happened: doing,
    likely_cause: 'The console has no more detail than the error below.',
    what_to_do: "Open the Session to read the agent's last messages, then Retry.",
    blocked_host: null,
    raw,
    resets_at: null,
    resume_point,
  };
}

/**
 * What a Retry carries on with: the first subagent that is not done, with how many finished, else the call the run
 * stopped in. Null when the run did nothing the console saw.
 */
export function resumePointOf(steps: StepFacts[], subagents: Subagent[]): string | null {
  if (subagents.length > 0) {
    const done = subagents.filter((one) => one.status === SubagentStatus.Done).length;
    const next = subagents.find((one) => one.status !== SubagentStatus.Done);
    if (!next) return `all ${subagents.length} subagents finished`;
    return `${next.description} (${done} of ${subagents.length} subagents finished)`;
  }
  const last = steps.at(-1);
  return last ? activityOf(last) : null;
}

const TEST_STEP =
  /\b(test|tests|jest|vitest|pytest|mocha|playwright|cargo\s+test|go\s+test|mvn|gradle|lint|tsc|check|build)\b/;

/** A command that looks: it reads the repo or the pull request and changes nothing. */
const LOOKS_ONLY =
  /^(git\s+(status|log|diff|show|branch|rev-parse|fetch|remote|ls-files|blame|describe|cat-file|merge-base|grep)|gh\s+(pr|issue|repo|run|api)\b|glab\s+(mr|issue)\s+(view|diff|list)|ls|cat|head|tail|grep|rg|find|pwd|wc|file|stat|tree|echo|sed\s+-n|which|cd)\b/;

/** The command's first part decides: `git status && ...` looks, whatever the rest does. */
const looksOnly = (command: string) => LOOKS_ONLY.test((command.split(/&&|;|\|/)[0] ?? '').trim());

/** What one call is evidence of. */
type Mark = 'explore' | 'edit' | 'test' | 'commit' | 'open_pr' | 'subagent' | 'other';

function markOf(step: StepFacts): Mark {
  const command = step.summary.startsWith('$ ') ? step.summary.slice(2) : null;
  if (
    step.tool.endsWith('open_pull_request') ||
    (command !== null && /\b(gh\s+pr\s+create|glab\s+mr\s+create)\b/.test(command))
  ) {
    return 'open_pr';
  }
  if (command !== null && /\bgit\s+commit\b/.test(command)) return 'commit';
  if (command !== null && TEST_STEP.test(command)) return 'test';
  if (step.phase === RunPhase.Editing) return 'edit';
  if (step.tool === 'Agent' || step.tool === 'Task') return 'subagent';
  if (step.phase === RunPhase.Reading) return 'explore';
  if (command !== null && looksOnly(command)) return 'explore';
  return 'other';
}

type PhaseDef = { id: string; label: string };

const CODE_PHASES: PhaseDef[] = [
  { id: 'read_task', label: 'Read task' },
  { id: 'explore', label: 'Explore' },
  { id: 'edit', label: 'Edit' },
  { id: 'run_tests', label: 'Run tests' },
  { id: 'fix', label: 'Fix' },
  { id: 'commit', label: 'Commit + hooks' },
  { id: 'open_pr', label: 'Open PR' },
];
const READ_PHASES: PhaseDef[] = [
  { id: 'read_task', label: 'Read task' },
  { id: 'explore', label: 'Explore' },
  { id: 'analyze', label: 'Analyze' },
  { id: 'report', label: 'Report' },
];
const REVIEW_PHASES: PhaseDef[] = [
  { id: 'read_pr', label: 'Read PR' },
  { id: 'explore', label: 'Explore' },
  { id: 'analyze', label: 'Analyze' },
  { id: 'write_comments', label: 'Write comments' },
  { id: 'post_review', label: 'Post review' },
];

/** The words and tone of the phase an ended run stopped in; null for one that finished. */
function stoppedOf(outcome: RunOutcome | null): RunPhaseStep['stopped'] {
  switch (outcome) {
    case RunOutcome.RateLimited:
      return { tone: 'limit', label: 'Stopped here: usage limit' };
    case RunOutcome.Failed:
    case RunOutcome.SignedOut:
    case RunOutcome.Interrupted:
      return { tone: 'failed', label: 'Stopped here: failed' };
    case RunOutcome.Stopped:
    case RunOutcome.Paused:
      return { tone: 'stopped', label: 'Stopped here' };
    default:
      return null;
  }
}

/**
 * The phases of this run and where it is in them. The set follows the run: a pull request review has its own, a run
 * that edits, tests, commits or opens a pull request has the code phases, and one that only reads and searches reads,
 * explores, analyzes and reports. A phase is `done` only with evidence of it; one the run went past without any is
 * `skipped`, and so is every phase after the last one reached once the run finished. `now` is the phase of the newest
 * call while the run goes, and of the call an ended run stopped at, which also carries why in `stopped`.
 */
export function phasesOf(input: {
  steps: StepFacts[];
  kind: SessionKind;
  running: boolean;
  outcome: RunOutcome | null;
  subagents?: number;
}): RunPhaseStep[] {
  const ordered = [...input.steps].sort((a, b) => a.startedAt - b.startedAt);
  const marks = ordered.map(markOf);
  const finished = !input.running && input.outcome === RunOutcome.Done;
  const has = (...wanted: Mark[]) => marks.some((mark) => wanted.includes(mark));
  const subagents = has('subagent') || (input.subagents ?? 0) > 0;
  const review = input.kind === SessionKind.PrReview;
  const code = !review && has('edit', 'test', 'commit', 'open_pr');
  const defs = review ? REVIEW_PHASES : code ? CODE_PHASES : READ_PHASES;

  /** Which phase of this run's set a call puts the run in. */
  const phaseOf = (mark: Mark, testSeen: boolean): string => {
    if (review) return mark === 'explore' ? 'explore' : 'analyze';
    if (!code) return mark === 'explore' ? 'explore' : 'analyze';
    switch (mark) {
      case 'open_pr':
        return 'open_pr';
      case 'commit':
        return 'commit';
      case 'test':
        return 'run_tests';
      case 'edit':
        return testSeen ? 'fix' : 'edit';
      default:
        return 'explore';
    }
  };

  const evidence = new Set<string>();
  if (ordered.length > 0) evidence.add(defs[0]?.id as string);
  let testSeen = false;
  let currentId: string | null = ordered.length > 0 ? 'explore' : (defs[0]?.id ?? null);
  let furthest = ordered.length > 0 ? 1 : -1;
  ordered.forEach((_step, index) => {
    const mark = marks[index] as Mark;
    const id = phaseOf(mark, testSeen);
    if (mark === 'test') testSeen = true;
    if (mark === 'other' && !review && code) return; // a command that marks no phase leaves the run where it was
    evidence.add(id);
    currentId = id;
    furthest = Math.max(
      furthest,
      defs.findIndex((def) => def.id === id),
    );
  });
  if (subagents && !code) evidence.add('analyze');
  if (finished) {
    for (const id of ['report', 'write_comments', 'post_review']) evidence.add(id);
    if (!code) evidence.add('analyze');
    furthest = defs.length - 1;
  }
  const current = defs.findIndex((def) => def.id === currentId);
  const stopped = input.running || finished ? null : stoppedOf(input.outcome);
  return defs.map((def, index): RunPhaseStep => {
    const here = index === current;
    const state: RunPhaseStep['state'] =
      (input.running || stopped !== null) && here
        ? 'now'
        : evidence.has(def.id) && (index <= furthest || finished)
          ? 'done'
          : index < furthest || (finished && index >= furthest)
            ? 'skipped'
            : 'todo';
    return { id: def.id, label: def.label, state, stopped: stopped !== null && here ? stopped : null };
  });
}

const timed = (step: StepFacts): TimedStep => ({
  id: step.id,
  agentId: step.agentId,
  tool: step.tool,
  phase: step.phase,
  startedAt: step.startedAt,
  finishedAt: step.finishedAt,
  waitedMs: step.waitedMs,
  ok: step.ok,
  summary: step.summary,
  error: step.error,
});

/**
 * Milliseconds per phase over the main agent's run, in the legend's order. Every millisecond of the run is in exactly
 * one phase, so the parts add up to the run's elapsed time; a gap between calls is thinking, time blocked on a
 * subagent is `Subagents`, and the wait on the usage limit is `WaitingLimit`. The shared lane code the page draws
 * its timeline from does the counting.
 */
export function splitTime(input: {
  steps: StepFacts[];
  startedAt: number;
  /** When the run ended; null while it goes, which counts to `now`. */
  endedAt: number | null;
  now: number;
  limitSince?: number | null;
}): { phase: RunPhase; ms: number }[] {
  const [main] = lanesOf({
    steps: input.steps.map(timed),
    subagents: [],
    runStart: input.startedAt,
    runEnd: input.endedAt,
    now: input.now,
    limitSince: input.limitSince ?? null,
  });
  return main?.split ?? PHASE_ORDER.map((phase) => ({ phase, ms: 0 }));
}
