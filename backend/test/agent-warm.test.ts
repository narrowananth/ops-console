import { SessionKind } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentDaemon, api, converse, gate, startAgentDaemon, until } from './agent-fixtures';

const running: AgentDaemon[] = [];
async function start(options: Parameters<typeof startAgentDaemon>[0] = {}) {
  const daemon = await startAgentDaemon(options);
  running.push(daemon);
  return daemon;
}

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

const warmed = async (daemon: AgentDaemon, count: number) =>
  until(
    () => daemon.sdk.warmed.length,
    (n) => n === count,
    'the spare process',
  );

describe('a spare Claude Code process for the next message', () => {
  it('serves the message the operator sends next', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    expect((await api(daemon).post(`/sessions/${id}/warm`)).status).toBe(204);
    await warmed(daemon, 1);

    daemon.sdk.script({ text: 'Hello.' });
    const session = await converse(daemon, id, 'hi');

    expect(daemon.sdk.warmed).toHaveLength(1);
    expect(daemon.sdk.warmed[0]).toMatchObject({ used: true, closed: false });
    expect(session.last_message_preview).toBe('Hello.');
    const messages = (await api(daemon).get(`/sessions/${id}/messages`)).body.data;
    expect(messages.map((message: { role: string }) => message.role)).toEqual(['user', 'agent']);
  });

  it('is closed and replaced when the message would start Claude Code differently', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    await api(daemon).post(`/sessions/${id}/warm`);
    await warmed(daemon, 1);
    await api(daemon).patch(`/sessions/${id}`, { model: 'claude-opus-5-5' });

    await converse(daemon, id, 'hi');

    expect(daemon.sdk.warmed[0]).toMatchObject({ used: false, closed: true });
    expect(daemon.sdk.calls[0]?.options.model).toBe('claude-opus-5-5');
  });

  it('is closed when no message comes', async () => {
    const daemon = await start({ warmTtlMs: 50 });
    const id = daemon.createSession();
    await api(daemon).post(`/sessions/${id}/warm`);
    await warmed(daemon, 1);
    await until(
      () => daemon.sdk.warmed[0]?.closed,
      (closed) => closed === true,
      'the unused process to close',
    );
    expect(daemon.sdk.warmed[0]?.used).toBe(false);
  });

  it('is refused while the Session runs, and for a Session that takes no messages', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    const hold = gate();
    daemon.sdk.script({ wait: hold.promise });
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'long job' });
    const busy = await api(daemon).post(`/sessions/${id}/warm`);
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('session_busy');
    hold.open();

    const review = daemon.createSession({ kind: SessionKind.PrReview });
    expect((await api(daemon).post(`/sessions/${review}/warm`)).status).toBe(409);
    expect(daemon.sdk.warmed).toHaveLength(0);
  });
});
