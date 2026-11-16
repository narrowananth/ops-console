import { AccessMode, ProcessState } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime';
import {
  BROWSER_CLICK_TOOL,
  BROWSER_EVALUATE_TOOL,
  PROCESS_OUTPUT_TOOL,
  START_PROCESS_TOOL,
  STOP_PROCESS_TOOL,
} from '../src/agent/session-tools';
import { BrowserModule } from '../src/browser/browser.module';
import { ProcessesModule } from '../src/processes/processes.module';
import { ProcessesService } from '../src/processes/processes.service';
import { type AgentDaemon, api, startAgentDaemon, until } from './agent-fixtures';
import { node, writeFixtures } from './process-fixtures';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

type Wait = { id: string; summary: string };

async function start() {
  const daemon = await startAgentDaemon({
    modules: [BrowserModule.forRoot({ chromePath: '/nonexistent/chrome' }), ProcessesModule.forRoot()],
  });
  running.push(daemon);
  const http = api(daemon);
  const chat = async (accessMode: AccessMode) => daemon.createSession({ access_mode: accessMode });
  const pending = async () => (await http.get('/approvals?status=pending')).body.data as Wait[];
  const processes = async (id: string) => (await http.get(`/sessions/${id}/processes`)).body.data;
  const idle = (id: string) =>
    until(
      async () => (await http.get(`/sessions/${id}`)).body.data.state,
      (state) => state === 'idle',
      'the run to end',
    );
  return { daemon, http, chat, pending, processes, idle };
}

describe('the agent starts processes and uses the browser', () => {
  it('asks for start_process in every Access mode, showing the command and that it runs outside the sandbox (26)', async () => {
    const { server } = await writeFixtures();
    for (const mode of Object.values(AccessMode)) {
      const ctx = await start();
      const id = await ctx.chat(mode);
      const command = node(server);
      ctx.daemon.sdk.script({ tool: START_PROCESS_TOOL, input: { name: 'api', command } });
      await ctx.http.post(`/sessions/${id}/messages`, { text: 'start the api' });
      const [wait] = await until(ctx.pending, (list) => list.length === 1, `an Approval in ${mode} mode`);
      expect(wait?.summary).toContain(command);
      expect(wait?.summary).toContain('outside the sandbox');
      // The tool has not run before the yes.
      expect(ctx.daemon.sdk.ran).toEqual([]);
      await ctx.http.post(`/approvals/${wait?.id}/decision`, { decision: 'approved' });
      await ctx.idle(id);
      expect(ctx.daemon.sdk.ran.map((call) => call.tool)).toEqual([START_PROCESS_TOOL]);
      await ctx.daemon.stop();
      running.pop();
    }
  });

  it("starts, reads and stops a process by name for the agent, marked as the agent's (26)", async () => {
    const { server } = await writeFixtures();
    const ctx = await start();
    const id = await ctx.chat(AccessMode.Supervised);
    const processes = ctx.daemon.app.get(ProcessesService);
    const started = await processes.startForAgent(id, { name: 'api', command: node(server) });
    expect(started).toMatchObject({ name: 'api', started_by: 'agent', state: ProcessState.Running });
    await until(
      () => processes.outputOf(id, 'api', 5),
      (output) => output.includes('listening on'),
      'the server to print its port',
    );
    expect((await processes.stopByName(id, 'api')).state).toBe(ProcessState.Stopped);
  });

  it('starts nothing on a no, and the agent is told not to retry (26)', async () => {
    const { server } = await writeFixtures();
    const ctx = await start();
    const id = await ctx.chat(AccessMode.Full);
    ctx.daemon.sdk.script({ tool: START_PROCESS_TOOL, input: { name: 'api', command: node(server) } });
    await ctx.http.post(`/sessions/${id}/messages`, { text: 'start the api' });
    const [wait] = await until(ctx.pending, (list) => list.length === 1, 'an Approval');
    await ctx.http.post(`/approvals/${wait?.id}/decision`, { decision: 'denied' });
    await ctx.idle(id);
    expect(await ctx.processes(id)).toEqual([]);
    expect(ctx.daemon.sdk.ran).toEqual([]);
  });

  it('refuses a folder outside the Session before it asks (26)', async () => {
    const ctx = await start();
    const id = await ctx.chat(AccessMode.Supervised);
    ctx.daemon.sdk.script({ tool: START_PROCESS_TOOL, input: { name: 'x', command: 'ls', folder: '/etc' } });
    await ctx.http.post(`/sessions/${id}/messages`, { text: 'go' });
    await ctx.idle(id);
    expect((await ctx.http.get('/approvals')).body.data).toEqual([]);
    expect(await ctx.processes(id)).toEqual([]);
  });

  it('runs process_output and stop_process with no Approval, each call an Action Log row (26, 23)', async () => {
    const ctx = await start();
    const id = await ctx.chat(AccessMode.Supervised);
    ctx.daemon.sdk.script({ tool: PROCESS_OUTPUT_TOOL, input: { name: 'api', lines: 5 } });
    ctx.daemon.sdk.script({ tool: STOP_PROCESS_TOOL, input: { name: 'api' } });
    await ctx.http.post(`/sessions/${id}/messages`, { text: 'check it, then stop it' });
    await ctx.idle(id);
    await ctx.http.post(`/sessions/${id}/messages`, { text: 'now stop it' });
    await ctx.idle(id);
    expect((await ctx.http.get('/approvals')).body.data).toEqual([]);
    expect(ctx.daemon.sdk.ran.map((call) => call.tool)).toEqual([PROCESS_OUTPUT_TOOL, STOP_PROCESS_TOOL]);
    const log = (await ctx.http.get(`/action-log?session_id=${id}`)).body.data as { command: string }[];
    expect(log.map((row) => row.command).join('\n')).toContain('process_output');
  });

  it('asks for browser_evaluate in every Access mode (23)', async () => {
    for (const mode of [AccessMode.Full, AccessMode.Supervised]) {
      const ctx = await start();
      const id = await ctx.chat(mode);
      ctx.daemon.sdk.script({ tool: BROWSER_EVALUATE_TOOL, input: { script: 'document.title' } });
      await ctx.http.post(`/sessions/${id}/messages`, { text: 'read the title' });
      const [wait] = await until(ctx.pending, (list) => list.length === 1, `an Approval in ${mode} mode`);
      expect(wait?.summary).toContain('document.title');
      await ctx.http.post(`/approvals/${wait?.id}/decision`, { decision: 'denied' });
      await ctx.idle(id);
      expect(ctx.daemon.sdk.ran).toEqual([]);
      await ctx.daemon.stop();
      running.pop();
    }
  });

  it('runs the other browser tools with no Approval in a supervised chat (23)', async () => {
    const ctx = await start();
    const id = await ctx.chat(AccessMode.Supervised);
    ctx.daemon.sdk.script({ tool: BROWSER_CLICK_TOOL, input: { ref: 'e1' } });
    await ctx.http.post(`/sessions/${id}/messages`, { text: 'click it' });
    await ctx.idle(id);
    expect((await ctx.http.get('/approvals')).body.data).toEqual([]);
    expect(ctx.daemon.sdk.ran.map((call) => call.tool)).toEqual([BROWSER_CLICK_TOOL]);
  });

  it('offers the tools in an operator chat and in no job (21, 26)', async () => {
    const ctx = await start();
    const id = await ctx.chat(AccessMode.Supervised);
    const names = (call: { options: { mcpServers?: Record<string, unknown> } }) => {
      const server = call.options.mcpServers?.['ops-console'] as
        | { instance: { _registeredTools: Record<string, unknown> } }
        | undefined;
      return Object.keys(server?.instance._registeredTools ?? {});
    };
    ctx.daemon.sdk.script({ text: 'ok' });
    await ctx.http.post(`/sessions/${id}/messages`, { text: 'hi' });
    await ctx.idle(id);
    const firstCall = ctx.daemon.sdk.calls[0];
    if (!firstCall) throw new Error('no run reached the SDK');
    // Chrome is missing here, so only the process tools are offered.
    expect(names(firstCall)).toEqual(expect.arrayContaining(['start_process', 'process_output', 'stop_process']));
    expect(names(firstCall).some((name) => name.startsWith('browser_'))).toBe(false);

    const before = ctx.daemon.sdk.calls.length;
    ctx.daemon.sdk.script({ text: 'ok' });
    await ctx.daemon.app.get(AgentRuntime).runFor(id, 'hi').finished;
    for (const call of ctx.daemon.sdk.calls.slice(before)) {
      expect(names(call).some((name) => name === 'start_process' || name.startsWith('browser_'))).toBe(false);
    }
  });
});
