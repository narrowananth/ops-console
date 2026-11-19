import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from '../helpers';

const SCRIPT = path.join(import.meta.dirname, 'logcli.mjs');

type Behavior = 'throttle' | 'unauthorized' | 'forbidden' | 'unreachable' | 'hang' | 'leak' | null;
type Auth = { basic: { username: string; password: string } } | { bearer: string } | null;
type State = {
  streams: { labels: Record<string, string>; entries: { at: number; line: string }[] }[];
  behavior: Behavior;
  reject: string | null;
  capitalized: boolean;
  auth: Auth;
  orgId: string | null;
  only: { counts?: 'hang'; samples?: 'hang' };
};
export type LokiCall = { args: string[]; pid: number; env: Record<string, string> };

/**
 * The `logcli` CLI as scripted state: the streams a Loki holds, each with its raw log lines. `bin` is a script that
 * runs the fake with the state and call log baked in, so the caller's environment needs nothing; `dir` is the folder
 * to put on a PATH to find it as `logcli`.
 */
export class FakeLogcli {
  private constructor(
    readonly dir: string,
    private readonly stateFile: string,
    private readonly logFile: string,
    private readonly state: State = {
      streams: [],
      behavior: null,
      reject: null,
      capitalized: false,
      auth: null,
      orgId: null,
      only: {},
    },
  ) {}

  static async create(): Promise<FakeLogcli> {
    const dir = await tempDir('ops-console-logcli-');
    const logcli = new FakeLogcli(dir, path.join(dir, 'state.json'), path.join(dir, 'calls.log'));
    writeFileSync(logcli.logFile, '');
    logcli.save();
    writeFileSync(
      logcli.bin,
      `#!/bin/sh\nLOKI_FAKE_STATE='${logcli.stateFile}' LOKI_FAKE_LOG='${logcli.logFile}' exec '${process.execPath}' '${SCRIPT}' "$@"\n`,
    );
    chmodSync(logcli.bin, 0o755);
    return logcli;
  }

  get bin(): string {
    return path.join(this.dir, 'logcli');
  }

  private save(): void {
    writeFileSync(this.stateFile, JSON.stringify(this.state));
  }

  /** A stream with these labels, holding `entries` (time in ms, and the JSON or plain line). */
  stream(labels: Record<string, string>, entries: { at: number; line: string | object }[] = []): this {
    this.state.streams.push({
      labels,
      entries: entries.map(({ at, line }) => ({ at, line: typeof line === 'string' ? line : JSON.stringify(line) })),
    });
    this.save();
    return this;
  }

  /** Every call fails or hangs the way a throttled, refusing, unreachable or slow Loki does. */
  behave(behavior: Behavior): this {
    this.state.behavior = behavior;
    this.save();
    return this;
  }

  /** One of a Scan's two queries, the metric one (`counts`) or the log one (`samples`), hangs. */
  behaveOn(query: 'counts' | 'samples', behavior: 'hang'): this {
    this.state.only[query] = behavior;
    this.save();
    return this;
  }

  /** `query` answers with a 400 whose body is `body`, as Loki does for a query limit. */
  rejectQueries(body: string): this {
    this.state.reject = body;
    this.save();
    return this;
  }

  /** The error line starts `Error response from server`, as `logcli` prints it on its POST paths. */
  printsCapitalized(): this {
    this.state.capitalized = true;
    this.save();
    return this;
  }

  /** The credentials and tenant this Loki accepts; any other call is refused. */
  requires(auth: Auth, orgId: string | null = null): this {
    this.state.auth = auth;
    this.state.orgId = orgId;
    this.save();
    return this;
  }

  calls(): LokiCall[] {
    return readFileSync(this.logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LokiCall);
  }

  /** The sub-commands called (`query`, `series`, `labels`), in order. */
  commands(): string[] {
    return this.calls().map((call) => call.args.find((arg) => !arg.startsWith('-')) ?? '');
  }
}
