import { FailureKind, RunHealth, RunOutcome, RunPhase, RunStage } from '@ops-console/shared';
import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  commandKey,
  diagnoseSlow,
  fmtMs,
  healthOf,
  historyOf,
  type StepFacts,
  splitTime,
  stagesOf,
  usualMs,
} from '../src/agent/run-insight';

const MIN = 60_000;
let counter = 0;

function step(over: Partial<StepFacts> & { summary: string; tool?: string }): StepFacts {
  return {
    id: `s${counter++}`,
    agentId: null,
    tool: over.tool ?? 'Bash',
    phase: over.phase ?? RunPhase.Commands,
    startedAt: 0,
    finishedAt: null,
    waitedMs: 0,
    ok: null,
    error: null,
    ...over,
  };
}

const past = (summary: string, took: number): StepFacts => step({ summary, startedAt: 0, finishedAt: took, ok: true });

describe('commandKey', () => {
  it('names a command by its first two words, past environment assignments', () => {
    expect(commandKey('$ CI=1 pnpm test backend')).toBe('pnpm test');
    expect(commandKey('$ git status')).toBe('git status');
    expect(commandKey('Read src/a.ts')).toBeNull();
  });
});

describe('usualMs', () => {
  it('says nothing until the command was seen three times, then the middle time', () => {
    const two = historyOf([past('$ pnpm test a', 30_000), past('$ pnpm test b', 50_000)]);
    expect(usualMs(two, '$ pnpm test')).toBeNull();
    const three = historyOf([
      past('$ pnpm test a', 30_000),
      past('$ pnpm test b', 50_000),
      past('$ pnpm test c', 40_000),
    ]);
    expect(usualMs(three, '$ pnpm test x')).toBe(40_000);
  });

  it('leaves out the time a call waited on the operator', () => {
    const history = historyOf(
      [1, 2, 3].map((n) =>
        step({ summary: '$ make', startedAt: 0, finishedAt: n * 100_000, waitedMs: 50_000, ok: true }),
      ),
    );
    expect(usualMs(history, '$ make')).toBe(150_000);
  });
});

describe('healthOf', () => {
  const base = { running: true, waiting: null, outcome: null, history: new Map(), failure: null };

  it('says a run waits on the operator, with what for', () => {
    const result = healthOf({ ...base, steps: [], now: 4 * MIN, waiting: { since: 0, on: '"Apply the fix?"' } });
    expect(result).toEqual({ health: RunHealth.NeedsYou, reason: 'Waiting on you for 4m 00s: "Apply the fix?"' });
  });

  it('calls a step slow past 3 times its usual time, and names the usual', () => {
    const history = historyOf([past('$ pnpm test', 40_000), past('$ pnpm test', 35_000), past('$ pnpm test', 50_000)]);
    const open = [step({ summary: '$ pnpm test backend', startedAt: 0 })];
    expect(healthOf({ ...base, history, steps: open, now: 100_000 }).health).toBe(RunHealth.OnTrack);
    expect(healthOf({ ...base, history, steps: open, now: 6 * MIN })).toEqual({
      health: RunHealth.Slow,
      reason: 'Slow: pnpm test backend running 6m 00s, usual 40s',
    });
  });

  it('calls an unknown command slow only past five minutes', () => {
    const open = [step({ summary: '$ ./deploy.sh', startedAt: 0 })];
    expect(healthOf({ ...base, steps: open, now: 4 * MIN }).health).toBe(RunHealth.OnTrack);
    expect(healthOf({ ...base, steps: open, now: 6 * MIN }).reason).toBe('Slow: ./deploy.sh running 6m 00s');
  });

  it('does not count the time a call waited for an Approval', () => {
    const open = [step({ summary: '$ ./deploy.sh', startedAt: 0, waitedMs: 5 * MIN })];
    expect(healthOf({ ...base, steps: open, now: 6 * MIN }).health).toBe(RunHealth.OnTrack);
  });

  it('reads an ended run as stopped, or failed with the reason', () => {
    expect(healthOf({ ...base, running: false, outcome: RunOutcome.Stopped, steps: [], now: 0 }).health).toBe(
      RunHealth.Stopped,
    );
    const failure = classifyFailure({ outcome: RunOutcome.RateLimited, lastError: null, steps: [] });
    expect(healthOf({ ...base, running: false, outcome: RunOutcome.RateLimited, steps: [], now: 0, failure })).toEqual({
      health: RunHealth.Failed,
      reason: 'Failed: The Claude account hit its usage limit.',
    });
  });
});

describe('diagnoseSlow', () => {
  it('ties a network command to the Run sandbox and finds the host to allow', () => {
    const open = [step({ summary: '$ curl -s https://api.example.com/v1/items', startedAt: 0 })];
    const result = diagnoseSlow({ steps: open, history: new Map(), now: 8 * MIN, queued: true });
    expect(result?.right_now).toContain('has run 8m 00s');
    expect(result?.likely_cause).toContain('reaches the network');
    expect(result?.blocked_host).toBe('api.example.com');
    expect(result?.also).toContain('queued');
  });

  it('says it cannot tell when the command shows no cause', () => {
    const open = [step({ summary: '$ ./slow-thing', startedAt: 0 })];
    expect(diagnoseSlow({ steps: open, history: new Map(), now: 8 * MIN, queued: false })?.likely_cause).toBe(
      'The console cannot see what this step waits on.',
    );
  });
});

describe('classifyFailure', () => {
  const failed = (summary: string, error: string) => [step({ summary, startedAt: 0, finishedAt: 1, ok: false, error })];

  it('finds the host the Run sandbox refused', () => {
    const result = classifyFailure({
      outcome: RunOutcome.Failed,
      lastError: null,
      steps: failed('$ pnpm install', 'ERR_PNPM_FETCH_403 GET https://registry.example.com/left-pad: Forbidden'),
    });
    expect(result).toMatchObject({ kind: FailureKind.NetworkBlocked, blocked_host: 'registry.example.com' });
    expect(result?.what_to_do).toContain('Allow registry.example.com');
  });

  it('names a failed commit hook and does not tell the agent to skip it', () => {
    const result = classifyFailure({
      outcome: RunOutcome.Failed,
      lastError: null,
      steps: failed('$ git commit -m x', 'husky - pre-commit hook exited with code 1'),
    });
    expect(result?.kind).toBe(FailureKind.HookFailed);
    expect(result?.what_to_do).toContain('does not skip hooks');
  });

  it('reads a blocked write, a usage limit, a sign-out and a restart', () => {
    expect(
      classifyFailure({
        outcome: RunOutcome.Failed,
        lastError: null,
        steps: failed('$ touch /etc/x', 'Operation not permitted'),
      })?.kind,
    ).toBe(FailureKind.WriteBlocked);
    expect(classifyFailure({ outcome: RunOutcome.RateLimited, lastError: null, steps: [] })?.kind).toBe(
      FailureKind.RateLimited,
    );
    expect(classifyFailure({ outcome: RunOutcome.SignedOut, lastError: null, steps: [] })?.kind).toBe(
      FailureKind.SignedOut,
    );
    expect(classifyFailure({ outcome: RunOutcome.Interrupted, lastError: null, steps: [] })?.kind).toBe(
      FailureKind.Interrupted,
    );
  });

  it('says plainly when it has no more than the error', () => {
    const result = classifyFailure({ outcome: RunOutcome.Failed, lastError: null, steps: failed('$ make', 'boom') });
    expect(result).toMatchObject({ kind: FailureKind.Unknown, raw: 'boom' });
    expect(result?.likely_cause).toBe('The console has no more detail than the error below.');
  });

  it('gives a stopped or finished run no failure', () => {
    expect(classifyFailure({ outcome: RunOutcome.Stopped, lastError: null, steps: [] })).toBeNull();
    expect(classifyFailure({ outcome: RunOutcome.Done, lastError: null, steps: [] })).toBeNull();
  });
});

describe('stagesOf', () => {
  const at = (n: number, over: Partial<StepFacts> & { summary: string }) =>
    step({ startedAt: n, finishedAt: n + 1, ok: true, ...over });
  const states = (steps: StepFacts[], running: boolean) =>
    Object.fromEntries(stagesOf(steps, running).map(({ stage, state }) => [stage, state]));

  it('puts a run that is running its tests at Run tests, with the earlier stages done', () => {
    const steps = [
      at(1, { summary: 'Read a.ts', tool: 'Read', phase: RunPhase.Reading }),
      at(2, { summary: 'Edit a.ts', tool: 'Edit', phase: RunPhase.Editing }),
      step({ summary: '$ pnpm test', startedAt: 3 }),
    ];
    expect(states(steps, true)).toEqual({
      [RunStage.ReadTask]: 'done',
      [RunStage.Explore]: 'done',
      [RunStage.Edit]: 'done',
      [RunStage.RunTests]: 'now',
      [RunStage.Fix]: 'todo',
      [RunStage.Commit]: 'todo',
      [RunStage.OpenPr]: 'todo',
    });
  });

  it('reads an edit after a test as a fix', () => {
    const steps = [
      at(1, { summary: '$ pnpm test' }),
      step({ summary: 'Edit a.ts', tool: 'Edit', phase: RunPhase.Editing, startedAt: 3 }),
    ];
    expect(states(steps, true)[RunStage.Fix]).toBe('now');
  });

  it('starts at Read task before any call, and marks every stage reached done once the run ends', () => {
    expect(states([], true)[RunStage.ReadTask]).toBe('now');
    const steps = [at(1, { summary: '$ git commit -m x' })];
    const ended = states(steps, false);
    expect(ended[RunStage.Commit]).toBe('done');
    expect(ended[RunStage.OpenPr]).toBe('todo');
  });
});

describe('splitTime', () => {
  it('counts a call by its phase, the wait apart, and the rest as thinking', () => {
    const steps = [
      step({ summary: 'Read a', tool: 'Read', phase: RunPhase.Reading, startedAt: 10_000, finishedAt: 30_000 }),
      step({ summary: '$ make', startedAt: 40_000, finishedAt: 100_000, waitedMs: 20_000 }),
      step({ summary: '$ sub', agentId: 't1', startedAt: 0, finishedAt: 100_000 }),
    ];
    const ms = Object.fromEntries(splitTime(steps, 0, 120_000).map(({ phase, ms }) => [phase, ms]));
    expect(ms).toEqual({
      [RunPhase.Reading]: 20_000,
      [RunPhase.Commands]: 40_000,
      [RunPhase.WaitingYou]: 20_000,
      [RunPhase.Editing]: 0,
      [RunPhase.Thinking]: 40_000,
    });
  });
});

describe('fmtMs', () => {
  it('reads seconds, minutes and hours', () => {
    expect([fmtMs(9_000), fmtMs(370_000), fmtMs(3_900_000)]).toEqual(['9s', '6m 10s', '1h 05m']);
  });
});
