import { type PlaybookStep, PlaybookTrigger, StepBlock, TRIGGER_LABELS } from '@ops-console/shared';

/** A Step block as the page offers it. Custom step starts empty; the operator writes its text. */
export type BlockTemplate = Omit<PlaybookStep, 'instructions'> & { instructions: string };

/** The ten Step blocks, in the page's order. They ship with the console so an update can improve them. */
export const STEP_BLOCKS: BlockTemplate[] = [
  {
    block: StepBlock.TraceLog,
    title: 'Trace the log through the code',
    instructions:
      'Find the code that wrote the log line. Follow the call path end to end: the entry point, the failing call and the data it read. Name each file:line.',
    writes: false,
  },
  {
    block: StepBlock.FindOwner,
    title: 'Find the Repo that owns it',
    instructions:
      'Decide which Repo really owns the failure. The Service that logged it may only pass on an error from another service or a shared library. Name the Repo and the file:line where the failure starts.',
    writes: false,
  },
  {
    block: StepBlock.FindUsers,
    title: 'Find who else uses it',
    instructions:
      'Find every other caller of the failing code and of the feature it serves: routes, jobs, other services and shared libraries. List them, so a fix does not break one of them in PROD.',
    writes: false,
  },
  {
    block: StepBlock.ReadConnections,
    title: 'Read real data from Connections',
    instructions:
      'Use the Connections you have, read only, to find the queries the code runs and the real shape of the data it reads: field names, types, nulls and odd values. Copy no PROD value anywhere. Skip this step when no Connection holds the data.',
    writes: false,
  },
  {
    block: StepBlock.ReplayRequest,
    title: 'Replay the request locally',
    instructions:
      'If the failure is a request, run this code locally and replay the request with curl. Note the request and the response, secrets removed. Skip this step when the code cannot run locally.',
    writes: true,
  },
  {
    block: StepBlock.MakeMockData,
    title: 'Make mock data',
    instructions:
      'Make mock data shaped like the real data you found: the same fields, types and edge cases, with made-up values. Write it as a test fixture in this folder.',
    writes: true,
  },
  {
    block: StepBlock.RunTests,
    title: 'Run the tests',
    instructions: 'Run the tests that cover the failing code, and note which pass and which fail.',
    writes: true,
  },
  {
    block: StepBlock.TestLastingFix,
    title: 'Test a lasting fix',
    instructions:
      'Write a test that fails on the bug with the mock data. Then try a fix that removes the cause instead of hiding the symptom, and run that test and the tests of its callers again. Answer failed when no fix makes them pass.',
    writes: true,
  },
  {
    block: StepBlock.CheckProdReadiness,
    title: 'Check PROD readiness',
    instructions:
      'Check PROD readiness: migrations, config and secrets, backwards compatibility with the callers you found, rollback, and tests.',
    writes: false,
  },
  { block: StepBlock.Custom, title: 'Custom step', instructions: '', writes: false },
];

/** Blocks whose steps always carry the scratch copy tag. */
export const WRITING_BLOCKS = new Set(STEP_BLOCKS.filter((block) => block.writes).map((block) => block.block));

export const FIX_CODE_STEP: PlaybookStep = {
  block: StepBlock.Custom,
  title: 'Code',
  instructions:
    'Implement the proposed fix on the current branch. Keep the change small and add or update a test. Do not commit and do not push.',
  writes: true,
};

export const FIX_TESTS_STEP: PlaybookStep = {
  block: StepBlock.Custom,
  title: 'Tests',
  instructions:
    'Run the tests in this Repo that cover the change, and fix what you broke. Answer failed when they still fail.',
  writes: true,
};

/** Today's method for each Trigger. Read-only; Duplicate copies one. */
export const BUILTIN_STEPS: Record<PlaybookTrigger, PlaybookStep[]> = {
  [PlaybookTrigger.Verify]: [
    {
      block: StepBlock.Custom,
      title: 'Map the log to the code',
      instructions:
        'Map the log to the code that wrote it, and follow the call path end to end: entry point, the failing call, the data it read.',
      writes: false,
    },
    {
      block: StepBlock.Custom,
      title: 'Replay the request',
      instructions:
        'If the failure is a request, replay it with curl against this code running locally, and note the response. Skip this step when it cannot run locally.',
      writes: true,
    },
    {
      block: StepBlock.Custom,
      title: 'Cross-check Connections',
      instructions: 'Cross-check the data with the Connections the console gives you, read only.',
      writes: false,
    },
    {
      block: StepBlock.Custom,
      title: 'Decide',
      instructions: 'Decide whether this is a bug or an improvement, and what the smallest fix is.',
      writes: false,
    },
  ],
  [PlaybookTrigger.Fix]: [FIX_CODE_STEP, FIX_TESTS_STEP],
  [PlaybookTrigger.ReviewPr]: [
    {
      block: StepBlock.Custom,
      title: 'Review',
      instructions:
        'Read the change as a careful reviewer would: what it breaks, what it misses, and its PROD readiness (migrations, config and secrets, backwards compatibility, rollback, tests). Change nothing and post no comments.',
      writes: false,
    },
  ],
  [PlaybookTrigger.ThreadReply]: [],
  [PlaybookTrigger.SessionMessage]: [],
  [PlaybookTrigger.DevtoolsAsk]: [],
};

export const builtinId = (trigger: PlaybookTrigger) => `builtin:${trigger}`;
export const builtinName = (trigger: PlaybookTrigger) => `${TRIGGER_LABELS[trigger].label} (built-in)`;
