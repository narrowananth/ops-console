import {
  type Failure,
  FailureKind,
  RunHealth,
  RunOutcome,
  RunPhase,
  RunStage,
  type SlowDiagnosis,
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
  const none = { raw: null, blocked_host: null };
  if (outcome === RunOutcome.RateLimited) {
    return {
      kind: FailureKind.RateLimited,
      what_happened: 'The Claude account hit its usage limit.',
      likely_cause: 'The account used up its usage window. Longer runs and larger models use it fastest.',
      what_to_do:
        'Switch to another account in Agents & accounts, or Retry after the limit resets. Work so far stays in the Session.',
      ...none,
      raw: input.lastError,
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
    };
  }
  return {
    kind: FailureKind.Unknown,
    what_happened: doing,
    likely_cause: 'The console has no more detail than the error below.',
    what_to_do: "Open the Session to read the agent's last messages, then Retry.",
    blocked_host: null,
    raw,
  };
}

const TEST_STEP =
  /\b(test|tests|jest|vitest|pytest|mocha|playwright|cargo\s+test|go\s+test|mvn|gradle|lint|tsc|check|build)\b/;

/** The stage one tool call belongs to; null for a call that marks none. */
function stageOf(step: StepFacts, testSeen: boolean): RunStage | null {
  const command = step.summary.startsWith('$ ') ? step.summary.slice(2) : null;
  if (
    step.tool.endsWith('open_pull_request') ||
    (command !== null && /\b(gh\s+pr\s+create|glab\s+mr\s+create)\b/.test(command))
  ) {
    return RunStage.OpenPr;
  }
  if (command !== null && /\bgit\s+commit\b/.test(command)) return RunStage.Commit;
  if (command !== null && TEST_STEP.test(command)) return RunStage.RunTests;
  if (step.phase === RunPhase.Editing) return testSeen ? RunStage.Fix : RunStage.Edit;
  if (step.phase === RunPhase.Reading || step.tool === 'Agent' || step.tool === 'Task') return RunStage.Explore;
  return null;
}

const STAGE_ORDER = [
  RunStage.ReadTask,
  RunStage.Explore,
  RunStage.Edit,
  RunStage.RunTests,
  RunStage.Fix,
  RunStage.Commit,
  RunStage.OpenPr,
];

/**
 * Where the run is in its usual order, read from the tools it used, so a run that works another way shows a stage it
 * skipped as done. `now` is the stage of the newest call while the run goes.
 */
export function stagesOf(steps: StepFacts[], running: boolean): { stage: RunStage; state: 'done' | 'now' | 'todo' }[] {
  let testSeen = false;
  let latest = -1;
  for (const step of [...steps].sort((a, b) => a.startedAt - b.startedAt)) {
    const stage = stageOf(step, testSeen);
    if (stage === RunStage.RunTests) testSeen = true;
    if (stage !== null) latest = Math.max(latest, STAGE_ORDER.indexOf(stage));
  }
  // The newest call may be an earlier stage than the furthest one (a fix after a test): `now` follows the newest.
  const newest = [...steps].sort((a, b) => a.startedAt - b.startedAt).at(-1);
  const newestStage = newest ? stageOf(newest, testSeen) : null;
  const now = running ? (newestStage === null ? Math.max(latest, 0) : STAGE_ORDER.indexOf(newestStage)) : -1;
  return STAGE_ORDER.map((stage, index) => ({
    stage,
    state: running
      ? index < now || (index === 0 && steps.length > 0)
        ? 'done'
        : index === now
          ? 'now'
          : 'todo'
      : index <= Math.max(latest, 0) && (steps.length > 0 || index === 0)
        ? 'done'
        : 'todo',
  }));
}

/** Milliseconds per phase over the run: the main agent's calls, time waiting on the operator, and the rest as thinking. */
export function splitTime(steps: StepFacts[], startedAt: number, endedAt: number): { phase: RunPhase; ms: number }[] {
  const ms: Record<RunPhase, number> = {
    [RunPhase.Thinking]: 0,
    [RunPhase.Reading]: 0,
    [RunPhase.Editing]: 0,
    [RunPhase.Commands]: 0,
    [RunPhase.WaitingYou]: 0,
  };
  let busy = 0;
  for (const step of steps) {
    if (step.agentId !== null) continue;
    const end = step.finishedAt ?? endedAt;
    const took = Math.max(0, end - step.startedAt);
    const waited = Math.min(step.waitedMs, took);
    ms[step.phase] += took - waited;
    ms[RunPhase.WaitingYou] += waited;
    busy += took;
  }
  ms[RunPhase.Thinking] = Math.max(0, endedAt - startedAt - busy);
  return Object.values(RunPhase).map((phase) => ({ phase, ms: Math.round(ms[phase]) }));
}
