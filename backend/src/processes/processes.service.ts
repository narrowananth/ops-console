import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  ConnectionEnv,
  type CreateProcessBody,
  ErrorCode,
  type LocalServer,
  type ProcessServerMessage,
  ProcessState,
  type Scripts,
  SessionKind,
  type SessionProcess,
  TabOpener,
} from '@ops-console/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import { OutputFiles } from '../agent/output-files';
import { AgentRuntime } from '../agent/runtime';
import { SessionKinds } from '../agent/session-kinds';
import { extraRepoIds, type SessionRow, SessionsService } from '../agent/sessions.service';
import { ApiError } from '../common/errors';
import { connections, repos, sessionProcesses, sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { loadPty } from '../terminals/pty';
import { LOCAL_SERVER_SCANNER, type LocalServerScanner } from './local-servers';
import { descendantsOf, familyOf, isAlive, processTable, signal } from './process-tree';
import { prodConnectionsNamedIn } from './prod-env';
import { readScripts, shellWord } from './scripts';

const REPLAY_CHARS = 256 * 1024;
const STOP_GRACE_MS = 3000;
/** A server that was just started needs a moment before it listens. */
const LISTEN_DELAY_MS = 1500;
const MAX_OUTPUT_LINES = 500;

type ProcessRow = typeof sessionProcesses.$inferSelect;

type Live = {
  sessionId: string;
  pty: IPty;
  pid: number;
  replay: string;
  state: ProcessState;
  exitCode: number | null;
  startedAt: string;
  stopRequested: boolean;
  prod: string[];
  exited: Promise<void>;
};

export type StartInput = Pick<CreateProcessBody, 'name' | 'folder'> & { command?: string; script?: string };

const SUPPORTED_KINDS: string[] = [SessionKind.Repo, SessionKind.Anonymous];

/** What a process's login shell gets from the daemon: the shell supplies PATH and the rest. */
function shellEnv(shell: string): Record<string, string> {
  const env: Record<string, string> = { SHELL: shell, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  for (const key of ['HOME', 'USER', 'LOGNAME', 'LANG']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** A login shell that reads the operator's rc files, so PATH and version managers are as in their terminal. */
export const shellArgs = (command: string): string[] => (command ? ['-ilc', command] : ['-il']);

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const ANSI = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[()][0-9A-Za-z]|\u001b[=>]/g;

const invalid = (message: string) => new ApiError(422, ErrorCode.ValidationFailed, message);

const inside = (folder: string, root: string) => {
  const relative = path.relative(root, folder);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const waitUntil = async (done: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
};

/**
 * Commands the daemon runs for a Session, as the operator and outside the Run sandbox. The rows persist; what is
 * running exists only in memory, so after a daemon restart every row is stopped.
 */
@Injectable()
export class ProcessesService implements OnModuleDestroy {
  private readonly live = new Map<string, Live>();
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(SessionKinds) private readonly kinds: SessionKinds,
    @Inject(OutputFiles) private readonly outputs: OutputFiles,
    @Inject(LOCAL_SERVER_SCANNER) private readonly scanner: LocalServerScanner,
    @Inject(AgentRuntime) runtime: AgentRuntime,
  ) {
    sessions.onRemoved((id) => this.release(id));
    runtime.setProcessTools(this);
  }

  async onModuleDestroy(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    await Promise.all([...this.live.values()].map((live) => this.terminate(live)));
  }

  /** Whether the Session has a Browser and Terminals: kinds `repo` and `anonymous`. */
  offers(sessionId: string): boolean {
    const kind = this.store.db
      .select({ kind: sessions.kind })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get()?.kind;
    return kind !== undefined && SUPPORTED_KINDS.includes(kind);
  }

  list(sessionId: string): SessionProcess[] {
    this.supported(sessionId);
    return this.store.db
      .select()
      .from(sessionProcesses)
      .where(eq(sessionProcesses.sessionId, sessionId))
      .orderBy(asc(sessionProcesses.createdAt), asc(sessionProcesses.id))
      .all()
      .map((row) => this.view(row));
  }

  async start(
    sessionId: string,
    input: StartInput,
    startedBy: TabOpener = TabOpener.Operator,
  ): Promise<SessionProcess> {
    const session = this.supported(sessionId);
    const workingDir = await this.workingDir(session);
    const folder = this.folderFor(session, workingDir, input.folder);
    if (
      !(await stat(folder).then(
        (info) => info.isDirectory(),
        () => false,
      ))
    )
      throw invalid('That folder does not exist');
    const command = input.script === undefined ? (input.command ?? '') : await this.scriptCommand(folder, input.script);
    const row = this.store.write((tx) =>
      tx
        .insert(sessionProcesses)
        .values({
          id: crypto.randomUUID(),
          sessionId,
          name: this.uniqueName(sessionId, input.name),
          command,
          folder,
          startedBy,
        })
        .returning()
        .get(),
    );
    try {
      this.spawn(row, await loadPty());
    } catch (error) {
      this.store.write((tx) => tx.delete(sessionProcesses).where(eq(sessionProcesses.id, row.id)).run());
      throw error;
    }
    return this.announce(row);
  }

  async stop(id: string): Promise<SessionProcess> {
    const row = this.row(id);
    const live = this.live.get(id);
    if (live?.state === ProcessState.Running) await this.terminate(live);
    return this.view(row);
  }

  async restart(id: string): Promise<SessionProcess> {
    const row = this.row(id);
    const live = this.live.get(id);
    if (live?.state === ProcessState.Running) await this.terminate(live);
    this.spawn(row, await loadPty());
    return this.announce(row);
  }

  /** Closes a process that is not running. */
  remove(id: string): void {
    const row = this.row(id);
    if (this.live.get(id)?.state === ProcessState.Running) {
      throw new ApiError(409, ErrorCode.InvalidState, 'Stop the process before closing it');
    }
    this.live.delete(id);
    for (const socket of this.sockets.get(id) ?? []) socket.close();
    this.sockets.delete(id);
    this.store.write((tx, emit) => {
      tx.delete(sessionProcesses).where(eq(sessionProcesses.id, id)).run();
      emit('process.removed', { session_id: row.sessionId, process_id: id });
    });
    this.store.emit('browser.servers_changed', { session_id: row.sessionId });
  }

  has(id: string): boolean {
    return (
      this.store.db
        .select({ id: sessionProcesses.id })
        .from(sessionProcesses)
        .where(eq(sessionProcesses.id, id))
        .get() !== undefined
    );
  }

  /** Sends the replay buffer, then what the process prints. */
  attach(id: string, socket: WebSocket): void {
    const set = this.sockets.get(id) ?? new Set<WebSocket>();
    this.sockets.set(id, set);
    set.add(socket);
    socket.on('close', () => set.delete(socket));
    const live = this.live.get(id);
    if (!live) return;
    if (live.replay) this.sendTo(socket, { type: 'output', data: live.replay });
    if (live.state !== ProcessState.Running) this.sendTo(socket, { type: 'exit', code: live.exitCode });
  }

  write(id: string, data: string): void {
    const live = this.live.get(id);
    if (live?.state === ProcessState.Running) live.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const live = this.live.get(id);
    if (live?.state === ProcessState.Running) live.pty.resize(cols, rows);
  }

  /** The folder's `package.json` scripts: the Session's working folder, or an Opened Repo's. */
  async scripts(sessionId: string, folder?: string): Promise<Scripts> {
    const session = this.supported(sessionId);
    const dir = this.folderFor(session, await this.workingDir(session), folder);
    return readScripts(dir);
  }

  /**
   * Stops the server on `port` when it is this Session's: one a Session process started, or one running in the
   * Session's folders. This reaches a server that outlived its process, such as one started with `nohup`. Any other
   * listener is 404, so the console never stops a process that is not the Session's.
   */
  async stopServer(sessionId: string, port: number): Promise<void> {
    const mine = (await this.localServers(sessionId)).find((server) => server.port === port && server.session_id);
    const listener = mine ? (await this.scanner.scan()).find((server) => server.port === port) : undefined;
    if (!mine || !listener) throw new ApiError(404, ErrorCode.NotFound, `no server of this Session on port ${port}`);
    // A server nobody owns may share a process group with things that are not the Session's: follow parents only.
    const family = descendantsOf(await processTable(), listener.pid);
    for (const pid of family) signal(pid, 'SIGTERM');
    const allGone = () => [...family].every((pid) => !isAlive(pid));
    if (!(await waitUntil(allGone, STOP_GRACE_MS))) {
      for (const pid of family) signal(pid, 'SIGKILL');
      await waitUntil(allGone, STOP_GRACE_MS);
    }
    this.store.emit('browser.servers_changed', { session_id: sessionId });
  }

  /** The Session's servers on a loopback port: one a Session process started, or one running in the Session's folders. */
  async localServers(sessionId: string): Promise<LocalServer[]> {
    const session = this.supported(sessionId);
    const [listening, table, roots] = await Promise.all([
      this.scanner.scan(),
      processTable(),
      this.sessionRoots(session),
    ]);
    const families = [...this.live.entries()]
      .filter(([, live]) => live.sessionId === sessionId && live.state === ProcessState.Running)
      .map(([id, live]) => ({ id, pids: familyOf(table, live.pid) }));
    const servers: LocalServer[] = [];
    for (const server of listening) {
      const owner = families.find((family) => family.pids.has(server.pid));
      const inFolders = server.folder !== '' && roots.some((root) => inside(server.folder, root));
      if (!owner && !inFolders) continue;
      servers.push({
        port: server.port,
        process: server.process,
        folder: server.folder,
        session_id: sessionId,
        process_id: owner?.id ?? null,
      });
    }
    return servers.sort((a, b) => a.port - b.port);
  }

  /** The Approval's text for the agent's `start_process`. Throws when the folder is not one the Session may use. */
  describeStart(
    sessionId: string,
    input: { name: string; command: string; folder?: string },
  ): { summary: string; folder: string; prod: string[] } {
    const session = this.supported(sessionId);
    const folder = this.folderFor(session, this.handler(session).workingDir(session), input.folder);
    const prod = this.prodIn(folder);
    const warning = prod.length
      ? `\nThis folder's .env names the PROD Connection${prod.length > 1 ? 's' : ''} ${prod.join(', ')}. The process can reach ${prod.length > 1 ? 'them' : 'it'}.`
      : '';
    return {
      folder,
      prod,
      summary: `Start "${input.name}" in ${folder}:\n${input.command}\nRuns as you, outside the sandbox, with this Repo's environment.${warning}`,
    };
  }

  private prodIn(folder: string): string[] {
    const prod = this.store.db
      .select({ name: connections.name, config: connections.config })
      .from(connections)
      .where(eq(connections.env, ConnectionEnv.Prod))
      .all();
    return prodConnectionsNamedIn(folder, prod);
  }

  startForAgent(sessionId: string, input: { name: string; command: string; folder?: string }): Promise<SessionProcess> {
    return this.start(sessionId, input, TabOpener.Agent);
  }

  /** The last `lines` lines (up to 500) of a process's output, without terminal control codes. */
  outputOf(sessionId: string, name: string, lines: number): string {
    const row = this.byName(sessionId, name);
    const text = (this.live.get(row.id)?.replay ?? '').replace(ANSI, '').replaceAll('\r\n', '\n').trimEnd();
    const kept = text.split('\n').map((line) => line.split('\r').pop() ?? '');
    return kept.slice(-Math.min(Math.max(Math.trunc(lines), 1), MAX_OUTPUT_LINES)).join('\n');
  }

  stopByName(sessionId: string, name: string): Promise<SessionProcess> {
    return this.stop(this.byName(sessionId, name).id);
  }

  private supported(sessionId: string): SessionRow {
    const session = this.sessions.get(sessionId);
    if (!SUPPORTED_KINDS.includes(session.kind)) {
      throw new ApiError(409, ErrorCode.BrowserNotAvailable, 'This Session has no terminals');
    }
    return session;
  }

  private handler(session: SessionRow) {
    const kind = this.kinds.get(session.kind);
    if (!kind) throw new ApiError(409, ErrorCode.BrowserNotAvailable, 'This Session has no terminals');
    return kind;
  }

  private row(id: string): ProcessRow {
    const row = this.store.db.select().from(sessionProcesses).where(eq(sessionProcesses.id, id)).get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, 'no such process');
    return row;
  }

  private byName(sessionId: string, name: string): ProcessRow {
    const row = this.store.db
      .select()
      .from(sessionProcesses)
      .where(and(eq(sessionProcesses.sessionId, sessionId), eq(sessionProcesses.name, name)))
      .get();
    if (!row) throw new ApiError(404, ErrorCode.NotFound, `no process named ${name}`);
    return row;
  }

  private view(row: ProcessRow): SessionProcess {
    const live = this.live.get(row.id);
    return {
      id: row.id,
      session_id: row.sessionId,
      name: row.name,
      command: row.command,
      folder: row.folder,
      state: live?.state ?? ProcessState.Stopped,
      exit_code: live?.exitCode ?? null,
      started_at: live?.startedAt ?? row.createdAt,
      started_by: row.startedBy === TabOpener.Agent ? TabOpener.Agent : TabOpener.Operator,
      prod_connections: live?.prod ?? [],
    };
  }

  /** Tells the panels the process changed, and again once a server it started has had time to listen. */
  private announce(row: ProcessRow): SessionProcess {
    const process = this.view(row);
    this.store.emit('process.changed', { session_id: row.sessionId, process });
    this.store.emit('browser.servers_changed', { session_id: row.sessionId });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.store.emit('browser.servers_changed', { session_id: row.sessionId });
    }, LISTEN_DELAY_MS);
    timer.unref();
    this.timers.add(timer);
    return process;
  }

  private uniqueName(sessionId: string, wanted: string): string {
    const taken = new Set(
      this.store.db
        .select({ name: sessionProcesses.name })
        .from(sessionProcesses)
        .where(eq(sessionProcesses.sessionId, sessionId))
        .all()
        .map((row) => row.name),
    );
    let name = wanted;
    for (let n = 2; taken.has(name); n++) name = `${wanted}-${n}`;
    return name;
  }

  /** The Session's working folder; a `repo` Session's worktree is made first when it is missing. */
  private async workingDir(session: SessionRow): Promise<string> {
    const kind = this.handler(session);
    const dir = kind.workingDir(session);
    if (
      !(await stat(dir).then(
        () => true,
        () => false,
      ))
    )
      await kind.prepare?.(session);
    return dir;
  }

  private openedRepoFolders(session: SessionRow): string[] {
    const ids = extraRepoIds(session);
    if (ids.length === 0) return [];
    const found = this.store.db
      .select({ path: repos.path })
      .from(repos)
      .where(and(inArray(repos.id, ids), isNull(repos.removedAt)))
      .all();
    return found.map((repo) => repo.path);
  }

  /** `folder` when it is the working folder or an Opened Repo's; the working folder without one. */
  private folderFor(session: SessionRow, workingDir: string, folder?: string): string {
    if (folder === undefined) return workingDir;
    const wanted = path.resolve(folder);
    const allowed = [workingDir, ...this.openedRepoFolders(session)];
    if (!allowed.some((candidate) => path.resolve(candidate) === wanted)) {
      throw invalid("The folder must be the Session's working folder or an Opened Repo's");
    }
    return wanted;
  }

  /** Folders a server's own folder may sit in to count as the Session's, as the filesystem names them. */
  private async sessionRoots(session: SessionRow): Promise<string[]> {
    const roots = [
      this.handler(session).workingDir(session),
      ...this.openedRepoFolders(session),
      this.outputs.folder(session.id),
    ];
    return Promise.all(roots.map((root) => realpath(root).catch(() => root)));
  }

  private async scriptCommand(folder: string, script: string): Promise<string> {
    const { runner, scripts } = await readScripts(folder);
    if (!scripts.some((entry) => entry.name === script)) throw invalid(`package.json has no script named ${script}`);
    return `${runner} run ${shellWord(script)}`;
  }

  private spawn(row: ProcessRow, nodePty: Awaited<ReturnType<typeof loadPty>>): void {
    const shell = process.env.SHELL || '/bin/zsh';
    const pty = nodePty.spawn(shell, shellArgs(row.command), {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: row.folder,
      env: shellEnv(shell),
    });
    let finished: () => void = () => {};
    const live: Live = {
      sessionId: row.sessionId,
      pty,
      pid: pty.pid,
      replay: '',
      state: ProcessState.Running,
      exitCode: null,
      startedAt: new Date().toISOString(),
      stopRequested: false,
      prod: this.prodIn(row.folder),
      exited: new Promise<void>((resolve) => {
        finished = resolve;
      }),
    };
    this.live.set(row.id, live);
    pty.onData((data) => {
      live.replay += data;
      // Trim in batches: slicing on every chunk copies the whole buffer for a process that prints a lot.
      if (live.replay.length > REPLAY_CHARS * 2) live.replay = live.replay.slice(-REPLAY_CHARS);
      this.broadcast(row.id, { type: 'output', data });
    });
    pty.onExit(({ exitCode, signal: killedBy }) => {
      live.state = live.stopRequested ? ProcessState.Stopped : ProcessState.Exited;
      live.exitCode = live.stopRequested ? null : killedBy ? 128 + killedBy : exitCode;
      this.broadcast(row.id, { type: 'exit', code: live.exitCode });
      finished();
      // A Session that was deleted announces nothing.
      if (this.live.get(row.id) !== live) return;
      this.store.emit('process.changed', { session_id: row.sessionId, process: this.view(row) });
      this.store.emit('browser.servers_changed', { session_id: row.sessionId });
    });
  }

  /** SIGHUP to the shell, as a closing terminal sends it, and SIGTERM to what it started; SIGKILL to what is left after 3 s. */
  private async terminate(live: Live): Promise<void> {
    if (live.state !== ProcessState.Running) return;
    live.stopRequested = true;
    const family = familyOf(await processTable(), live.pid);
    signal(live.pid, 'SIGHUP');
    for (const pid of family) if (pid !== live.pid) signal(pid, 'SIGTERM');
    const allGone = () => [...family].every((pid) => !isAlive(pid));
    if (!(await waitUntil(allGone, STOP_GRACE_MS))) {
      for (const pid of familyOf(await processTable(), live.pid)) family.add(pid);
      for (const pid of family) signal(pid, 'SIGKILL');
      await waitUntil(allGone, STOP_GRACE_MS);
    }
    await live.exited;
  }

  /** A Session was deleted: its processes stop and are forgotten. */
  private async release(sessionId: string): Promise<void> {
    const mine = [...this.live.entries()].filter(([, live]) => live.sessionId === sessionId);
    for (const [id] of mine) {
      this.live.delete(id);
      for (const socket of this.sockets.get(id) ?? []) socket.close();
      this.sockets.delete(id);
    }
    await Promise.all(mine.map(([, live]) => this.terminate(live)));
    this.store.emit('browser.servers_changed', { session_id: sessionId });
  }

  private broadcast(id: string, message: ProcessServerMessage): void {
    for (const socket of this.sockets.get(id) ?? []) this.sendTo(socket, message);
  }

  private sendTo(socket: WebSocket, message: ProcessServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }
}
