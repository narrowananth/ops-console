import { type LocalServer, type SessionProcess, TabOpener } from '@ops-console/shared';
import { expect, test } from '@playwright/test';
import { freshServers } from '../src/browser/servers';

const server = (port: number, processId: string | null): LocalServer => ({
  port,
  process: 'node',
  folder: '/work/app',
  session_id: 's1',
  process_id: processId,
});

const started = (id: string, startedBy: SessionProcess['started_by']) => ({ id, started_by: startedBy });

test.describe('which started servers open a page by themselves (Behavior 11a)', () => {
  test('a server the operator started opens, once per port', () => {
    const servers = [server(5173, 'web')];
    const processes = [started('web', TabOpener.Operator)];
    expect(freshServers(servers, new Set(), new Set(), processes).map((one) => one.port)).toEqual([5173]);
    expect(freshServers(servers, new Set(), new Set([5173]), processes)).toEqual([]);
  });

  test('a server the agent started does not open a page: the agent opens it itself when it wants it seen', () => {
    // A test run starts a daemon on a port of its own; a tab for it would show a sign-in or a dead address.
    const servers = [server(60620, 'tests')];
    expect(freshServers(servers, new Set(), new Set(), [started('tests', TabOpener.Agent)])).toEqual([]);
  });

  test('a server of a process that was already there, and one no process owns, stay closed', () => {
    const servers = [server(4000, 'old'), server(4001, null)];
    const processes = [started('old', TabOpener.Operator)];
    expect(freshServers(servers, new Set(['old']), new Set(), processes)).toEqual([]);
  });

  test('a process missing from the list is read as the operator’s, so a started page is never lost to a race', () => {
    expect(freshServers([server(5000, 'new')], new Set(), new Set(), []).map((one) => one.port)).toEqual([5000]);
  });
});
