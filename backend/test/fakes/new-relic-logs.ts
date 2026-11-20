import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from '../helpers';

const SCRIPT = path.join(import.meta.dirname, 'newrelic.mjs');

type Behavior = 'throttle' | 'unauthorized' | 'forbidden' | 'unreachable' | 'timeout' | 'hang' | 'leak' | null;
type Account = { apiKey: string; accountId: string; region: string };
type State = {
  events: { at: number; attrs: Record<string, unknown> }[];
  behavior: Behavior;
  reject: string | null;
  requires: Account | null;
  facetStyle: 'array' | 'keys';
  only: { counts?: 'hang'; samples?: 'hang' };
};
export type NewRelicCall = { args: string[]; pid: number; env: Record<string, string> };

/**
 * The `newrelic` CLI as scripted state: the log events an account holds, each with flat attributes as New Relic stores
 * them. `bin` is a script that runs the fake with the state and call log baked in, so the caller's environment needs
 * nothing; `dir` is the folder to put on a PATH to find it as `newrelic`.
 */
export class FakeNewRelic {
  private constructor(
    readonly dir: string,
    private readonly stateFile: string,
    private readonly logFile: string,
    private readonly state: State = {
      events: [],
      behavior: null,
      reject: null,
      requires: null,
      facetStyle: 'array',
      only: {},
    },
  ) {}

  static async create(): Promise<FakeNewRelic> {
    const dir = await tempDir('ops-console-newrelic-');
    const newrelic = new FakeNewRelic(dir, path.join(dir, 'state.json'), path.join(dir, 'calls.log'));
    writeFileSync(newrelic.logFile, '');
    newrelic.save();
    writeFileSync(
      newrelic.bin,
      `#!/bin/sh\nNR_FAKE_STATE='${newrelic.stateFile}' NR_FAKE_LOG='${newrelic.logFile}' exec '${process.execPath}' '${SCRIPT}' "$@"\n`,
    );
    chmodSync(newrelic.bin, 0o755);
    return newrelic;
  }

  get bin(): string {
    return path.join(this.dir, 'newrelic');
  }

  private save(): void {
    writeFileSync(this.stateFile, JSON.stringify(this.state));
  }

  /** Log events with these attributes, at times in ms. */
  events(...events: { at: number; attrs: Record<string, unknown> }[]): this {
    this.state.events.push(...events);
    this.save();
    return this;
  }

  /** Every call fails or hangs the way a throttled, refusing, unreachable or slow New Relic does. */
  behave(behavior: Behavior): this {
    this.state.behavior = behavior;
    this.save();
    return this;
  }

  /** One of a Scan's queries, the counts (`counts`) or the events (`samples`), hangs. */
  behaveOn(query: 'counts' | 'samples', behavior: 'hang'): this {
    this.state.only[query] = behavior;
    this.save();
    return this;
  }

  /** Every query fails with `message`, as New Relic does for a syntax error or a query limit. */
  rejectQueries(message: string): this {
    this.state.reject = message;
    this.save();
    return this;
  }

  /** The key, account and region this account accepts; any other call is refused as a rejected key. */
  requires(account: Account): this {
    this.state.requires = account;
    this.save();
    return this;
  }

  /** A FACET row names its values by attribute, not in one `facet` field. */
  facetsByName(): this {
    this.state.facetStyle = 'keys';
    this.save();
    return this;
  }

  calls(): NewRelicCall[] {
    return readFileSync(this.logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as NewRelicCall);
  }

  /** The NRQL of each call, in order. */
  queries(): string[] {
    return this.calls().map((call) => {
      const at = call.args.indexOf('--query');
      return at >= 0
        ? (call.args[at + 1] ?? '')
        : (call.args.find((arg) => arg.startsWith('--query='))?.slice(8) ?? '');
    });
  }
}
