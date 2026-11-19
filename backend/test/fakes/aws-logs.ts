import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from '../helpers';

export const AWS_BIN = path.join(import.meta.dirname, 'aws.mjs');

type Behavior = 'throttle' | 'signed_out' | 'unreachable' | 'hang' | null;
type State = {
  groups: Record<string, { events: { at: number; message: string }[] }>;
  behavior: Behavior;
  bytes: number;
  startDelayMs: number;
  only: { counts?: 'hang' | 'fail'; events?: 'hang' | 'fail' };
};
type Call = { args: string[]; profile?: string; region?: string };

/**
 * The `aws` CLI's Logs Insights as scripted state: the raw log lines each group holds. The fake binary reads the state
 * and a call log from the files named in this process's environment, which `use` sets.
 */
export class FakeAws {
  private constructor(
    private readonly stateFile: string,
    private readonly logFile: string,
    private readonly state: State = { groups: {}, behavior: null, bytes: 1000, startDelayMs: 0, only: {} },
  ) {}

  static async create(): Promise<FakeAws> {
    const dir = await tempDir('ops-console-aws-');
    const aws = new FakeAws(path.join(dir, 'state.json'), path.join(dir, 'calls.log'));
    writeFileSync(aws.logFile, '');
    aws.save();
    process.env.AWS_FAKE_STATE = aws.stateFile;
    process.env.AWS_FAKE_LOG = aws.logFile;
    return aws;
  }

  private save(): void {
    writeFileSync(this.stateFile, JSON.stringify(this.state));
  }

  /** A log group the account has, holding `events` (time in ms, and the JSON or plain line). */
  group(name: string, events: { at: number; message: string | object }[] = []): this {
    this.state.groups[name] = {
      events: events.map(({ at, message }) => ({
        at,
        message: typeof message === 'string' ? message : JSON.stringify(message),
      })),
    };
    this.save();
    return this;
  }

  /** Every call fails or hangs the way a throttled, signed-out, unreachable or slow AWS does. */
  behave(behavior: Behavior): this {
    this.state.behavior = behavior;
    this.save();
    return this;
  }

  /** One of a Scan's two queries, the one that aggregates (`counts`) or the one that reads events, hangs or ends Failed. */
  behaveOn(query: 'counts' | 'events', behavior: 'hang' | 'fail'): this {
    this.state.only[query] = behavior;
    this.save();
    return this;
  }

  /** `start-query` answers this long after it is called. */
  startsAfter(ms: number): this {
    this.state.startDelayMs = ms;
    this.save();
    return this;
  }

  scans(bytes: number): this {
    this.state.bytes = bytes;
    this.save();
    return this;
  }

  /** The `aws` calls so far, as their `logs` sub-command. */
  calls(): Call[] {
    return readFileSync(this.logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Call);
  }

  /** The sub-commands called (`start-query`, `stop-query`), in order. */
  commands(): string[] {
    return this.calls().map((call) => call.args[1] as string);
  }
}
