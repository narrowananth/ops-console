import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Module } from '@nestjs/common';
import { SessionKind, WS_PROTOCOL, type WsEvent } from '@ops-console/shared';
import request from 'supertest';
import WebSocket from 'ws';
import { AgentModule } from '../src/agent/agent.module';
import { ProdWriteRule } from '../src/agent/prod-write-rule';
import { SessionKinds } from '../src/agent/session-kinds';
import { type NewSession, SessionsService } from '../src/agent/sessions.service';
import { FakeAgentSdk } from './fakes/agent-sdk';
import { startTestDaemon, type TestDaemon, tempDir } from './helpers';

/** Every agent test daemon runs its Sessions here. */
export let WORKING_DIR = '';

/**
 * Registers the kinds the way `07-workspace` will, and a PROD-write rule the way `05-settings-dev-tools` will:
 * a Bash command that writes through `psql-prod`.
 */
@Injectable()
class KindsFixture {
  constructor(@Inject(SessionKinds) kinds: SessionKinds, @Inject(ProdWriteRule) rule: ProdWriteRule) {
    kinds.register(SessionKind.Repo, { workingDir: () => WORKING_DIR, acceptsMessages: true });
    kinds.register(SessionKind.PrReview, { workingDir: () => WORKING_DIR, acceptsMessages: false });
    rule.use(({ toolName, input }) =>
      toolName === 'Bash' && /psql-prod .*\b(update|insert|delete)\b/i.test(String(input.command))
        ? { summary: `PROD write: ${String(input.command)}` }
        : null,
    );
  }
}

@Module({ providers: [KindsFixture] })
class KindsFixtureModule {}

export type AgentDaemon = TestDaemon & {
  sdk: FakeAgentSdk;
  sockets: Set<WebSocket>;
  dataDir: string;
  /** The operator's own Claude Code config dir. */
  home: string;
  auth: { Authorization: string };
  createSession(input?: Partial<NewSession>): string;
};

/** Signs the config dir in, as `claude auth login` would, for the fake `claude` CLI. */
export async function signIn(configDir: string, email: string, plan = 'max'): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'fake-auth.json'), JSON.stringify({ email, subscriptionType: plan }));
}

export async function startAgentDaemon(
  options: { dataDir?: string; home?: string; signedIn?: boolean } = {},
): Promise<AgentDaemon> {
  const dataDir = options.dataDir ?? (await tempDir());
  const home = options.home ?? (await tempDir('ops-console-claude-'));
  WORKING_DIR ||= await tempDir('ops-console-repo-');
  if (options.signedIn ?? true) await signIn(home, 'operator@example.com');
  process.env.FAKE_CLAUDE_HOME = home;
  const sdk = new FakeAgentSdk(home);
  const daemon = await startTestDaemon({
    dataDir,
    modules: [AgentModule.forRoot({ sdk, claudeHome: home }), { module: KindsFixtureModule }],
  });
  const sockets = new Set<WebSocket>();
  const stop = daemon.stop;
  return Object.assign(daemon, {
    sockets,
    // A test that fails before closing its socket would hold the HTTP server open.
    stop: async () => {
      for (const socket of sockets) socket.terminate();
      await stop();
    },
    sdk,
    dataDir,
    home,
    auth: { Authorization: `Bearer ${daemon.token}` },
    createSession: (input: Partial<NewSession> = {}) =>
      daemon.app.get(SessionsService).create({ kind: SessionKind.Repo, ...input }).id,
  });
}

export async function until<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  what = 'condition',
): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export const api = (daemon: AgentDaemon) => ({
  get: (url: string) => request(daemon.url).get(`/api${url}`).set(daemon.auth),
  post: (url: string, body?: object) => request(daemon.url).post(`/api${url}`).set(daemon.auth).send(body),
  patch: (url: string, body: object) => request(daemon.url).patch(`/api${url}`).set(daemon.auth).send(body),
  delete: (url: string) => request(daemon.url).delete(`/api${url}`).set(daemon.auth),
});

/** Sends a message and waits for the run to finish. */
export async function converse(daemon: AgentDaemon, sessionId: string, text: string) {
  const sent = await api(daemon).post(`/sessions/${sessionId}/messages`, { text });
  if (sent.status !== 202) throw new Error(`send failed: ${sent.status} ${JSON.stringify(sent.body)}`);
  return until(
    async () => (await api(daemon).get(`/sessions/${sessionId}`)).body.data,
    (session) => session.state === 'idle' || session.state === 'failed',
    'the run to end',
  );
}

/** Collects WebSocket events from the moment the socket opens. */
export async function listen(daemon: AgentDaemon): Promise<{ events: WsEvent[]; close: () => void }> {
  const socket = new WebSocket(`${daemon.url.replace('http', 'ws')}/ws`, [WS_PROTOCOL, daemon.token]);
  daemon.sockets.add(socket);
  const events: WsEvent[] = [];
  socket.on('message', (raw) => events.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { events, close: () => socket.close() };
}

/** A promise the test settles by hand, to hold a run open. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
