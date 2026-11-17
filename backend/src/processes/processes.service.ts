import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
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
import { baseEnv, type Env, LoginEnv } from './login-env';
import { descendantsOf, familyOf, isAlive, processTable, signal } from './process-tree';
import { prodConnectionsNamedIn } from './prod-env';
import { readScripts } from './scripts';

const REPLAY_CHARS = 256 * 1024;
const STOP_GRACE_MS = 1500;
/** Restart starts the command again at once, so what ignores the hangup is killed sooner. */
const RESTART_GRACE_MS = 500;
const MAX_OUTPUT_LINES = 500;
/** A started server needs a moment before it listens: the scanner is asked this often, for this long. */
const LISTEN_POLL_MS = 500;
const LISTEN_WATCH_MS = 30_000;
/** A scan or process table this old is reused by a read. */
const SCAN_CACHE_MS = 1500;
/** Output that arrives within this window goes out as one message. */
const FLUSH_MS = 8;
/** A viewer this far behind pauses the process until it catches up. */
const MAX_BUFFERED = 1_000_000;
const DRAIN_CHECK_MS = 50;
/** Folders whose login environment is read at start-up. */
const WARM_FOLDERS = 3;

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
  /** Output read from the pty and not yet sent. */
  pending: string;
  flushing: NodeJS.Timeout | undefined;
  /** Set while the pty is paused for a slow viewer. */
  draining: NodeJS.Timeout | undefined;
};

export type StartInput = Pick<CreateProcessBody, 'name' | 'folder'> & { command?: string; script?: string };

const SUPPORTED_KINDS: string[] = [SessionKind.Repo, SessionKind.Anonymous];

/**
 * A command runs as `-c` with the login environment read earlier, or as `-ilc` (a login shell that reads the operator's
 * rc files) while that is not ready. A shell with no command is always the login shell, for the operator to type in.
 */
export const shellArgs = (command: string, env: Env | null = null): string[] =>
  command ? [env ? '-c' : '-ilc', command] : ['-il'];

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
export class ProcessesService implements OnModuleInit, OnModuleDestroy {
  private readonly live = new Map<string, Live>();
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private stopped = false;
  /** When a Session's servers last changed: a read never reuses a scan older than this. */
  private changedAt = 0;

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(SessionKinds) private readonly kinds: SessionKinds,
    @Inject(OutputFiles) private readonly outputs: OutputFiles,
    @Inject(LOCAL_SERVER_SCANNER) private readonly scanner: LocalServerScanner,
    @Inject(LoginEnv) private readonly loginEnv: LoginEnv,
    @Inject(AgentRuntime) runtime: AgentRuntime,
  ) {
    sessions.onRemoved((id) => this.release(id));
    runtime.setProcessTools(this);
  }

  /** Reads the login environment of the folders that had processes, in the background: Restart then skips the shell's start-up. */
  onModuleInit(): void {
    const rows = this.store.db.select({ folder: sessionProcesses.folder }).from(sessionProcesses).all();
    for (const folder of [...new Set(rows.map((row) => row.folder))].slice(0, WARM_FOLDERS)) {
      this.loginEnv.warm(this.shell(), folder);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
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
      await this.spawn(row);
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
    if (live?.state === ProcessState.Running) await this.terminate(live, RESTART_GRACE_MS);
    await this.spawn(row);
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
    this.serversChanged(row.sessionId);
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
    this.flush(id, live);
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

  /** What the folder can run: the Session's working folder, or an Opened Repo's. */
  async scripts(sessionId: string, folder?: string): Promise<Scripts> {
    const session = this.supported(sessionId);
    const dir = this.folderFor(session, await this.workingDir(session), folder);
    // The Run menu opens before a command starts: read the login environment now so the command skips the shell's start-up.
    this.loginEnv.warm(this.shell(), dir);
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
    this.serversChanged(sessionId);
  }

  /** The Session's servers on a loopback port: one a Session process started, or one running in the Session's folders. */
  async localServers(sessionId: string): Promise<LocalServer[]> {
    const session = this.supported(sessionId);
    const age = Math.min(SCAN_CACHE_MS, Date.now() - this.changedAt);
    const [listening, table, roots] = await Promise.all([
      this.scanner.scan(age),
      processTable(age),
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
  async describeStart(
    sessionId: string,
    input: { name: string; command: string; folder?: string },
  ): Promise<{ summary: string; folder: string; prod: string[] }> {
    const session = this.supported(sessionId);
    const folder = this.folderFor(session, this.handler(session).workingDir(session), input.folder);
    // The Approval waits for the operator: the login environment is ready by the time they say yes.
    this.loginEnv.warm(this.shell(), folder);
    const prod = await this.prodIn(folder);
    const warning = prod.length
      ? `\nThis folder's .env names the PROD Connection${prod.length > 1 ? 's' : ''} ${prod.join(', ')}. The process can reach ${prod.length > 1 ? 'them' : 'it'}.`
      : '';
    return {
      folder,
      prod,
      summary: `Start "${input.name}" in ${folder}:\n${input.command}\nRuns as you, outside the sandbox, with this Repo's environment.${warning}`,
    };
  }

  private prodIn(folder: string): Promise<string[]> {
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
    const live = this.live.get(row.id);
    if (live) this.flush(row.id, live);
    const text = (live?.replay ?? '').replace(ANSI, '').replaceAll('\r\n', '\n').trimEnd();
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

  private shell(): string {
    return process.env.SHELL || '/bin/zsh';
  }

  private serversChanged(sessionId: string): void {
    this.changedAt = Date.now();
    this.store.emit('browser.servers_changed', { session_id: sessionId });
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

  /** Tells the panels the process changed, and again when a server it started listens. */
  private announce(row: ProcessRow): SessionProcess {
    const process = this.view(row);
    this.store.emit('process.changed', { session_id: row.sessionId, process });
    this.serversChanged(row.sessionId);
    const live = this.live.get(row.id);
    // A shell the operator types in may start a server much later: the panel's slow poll finds that one.
    if (live && row.command) void this.watchListening(row, live);
    return process;
  }

  /** Asks the scanner often after a start, and tells the panels at the first listener under the process. */
  private async watchListening(row: ProcessRow, live: Live): Promise<void> {
    const until = Date.now() + LISTEN_WATCH_MS;
    while (Date.now() < until && !this.stopped) {
      await new Promise((resolve) => setTimeout(resolve, LISTEN_POLL_MS).unref());
      if (this.live.get(row.id) !== live || live.state !== ProcessState.Running) return;
      const listening = await this.scanner.scan().catch(() => []);
      const family = familyOf(await processTable(SCAN_CACHE_MS).catch(() => []), live.pid);
      if (listening.some((server) => family.has(server.pid))) {
        this.serversChanged(row.sessionId);
        return;
      }
    }
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

  /** The command line of a script the folder lists, by its id (`package.json:dev`); the client never sends the line. */
  private async scriptCommand(folder: string, script: string): Promise<string> {
    const found = (await readScripts(folder)).scripts.find((entry) => entry.id === script);
    if (!found) throw invalid(`The folder has no script ${script}`);
    return found.run;
  }

  private async spawn(row: ProcessRow): Promise<void> {
    const shell = this.shell();
    const [nodePty, prod, login] = await Promise.all([
      loadPty(),
      this.prodIn(row.folder),
      row.command ? this.loginEnv.get(shell, row.folder) : null,
    ]);
    const pty = nodePty.spawn(shell, shellArgs(row.command, login), {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: row.folder,
      env: login ? { ...login, SHELL: shell, TERM: 'xterm-256color', COLORTERM: 'truecolor' } : baseEnv(shell),
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
      prod,
      exited: new Promise<void>((resolve) => {
        finished = resolve;
      }),
      pending: '',
      flushing: undefined,
      draining: undefined,
    };
    this.live.set(row.id, live);
    pty.onData((data) => {
      live.pending += data;
      live.flushing ??= setTimeout(() => this.flush(row.id, live), FLUSH_MS);
    });
    pty.onExit(({ exitCode, signal: killedBy }) => {
      this.flush(row.id, live);
      clearInterval(live.draining);
      live.state = live.stopRequested ? ProcessState.Stopped : ProcessState.Exited;
      live.exitCode = live.stopRequested ? null : killedBy ? 128 + killedBy : exitCode;
      this.broadcast(row.id, { type: 'exit', code: live.exitCode });
      finished();
      // A Session that was deleted announces nothing.
      if (this.live.get(row.id) !== live) return;
      this.store.emit('process.changed', { session_id: row.sessionId, process: this.view(row) });
      this.serversChanged(row.sessionId);
    });
  }

  /** Sends what the pty printed since the last send as one message and keeps it for a viewer that opens late. */
  private flush(id: string, live: Live): void {
    clearTimeout(live.flushing);
    live.flushing = undefined;
    const data = live.pending;
    if (!data) return;
    live.pending = '';
    live.replay += data;
    // Trim in batches: slicing on every chunk copies the whole buffer for a process that prints a lot.
    if (live.replay.length > REPLAY_CHARS * 2) live.replay = live.replay.slice(-REPLAY_CHARS);
    this.broadcast(id, { type: 'output', data });
    this.holdForSlowViewer(id, live);
  }

  /** A viewer with over 1 MB unsent pauses the process until every viewer has caught up. */
  private holdForSlowViewer(id: string, live: Live): void {
    const behind = () => [...(this.sockets.get(id) ?? [])].some((socket) => socket.bufferedAmount > MAX_BUFFERED);
    if (live.draining || live.state !== ProcessState.Running || !behind()) return;
    live.pty.pause();
    live.draining = setInterval(() => {
      if (behind()) return;
      clearInterval(live.draining);
      live.draining = undefined;
      if (live.state === ProcessState.Running) live.pty.resume();
    }, DRAIN_CHECK_MS);
  }

  /** SIGHUP to the shell, as a closing terminal sends it, and SIGTERM to what it started; SIGKILL to what is left after `graceMs`. */
  private async terminate(live: Live, graceMs = STOP_GRACE_MS): Promise<void> {
    if (live.state !== ProcessState.Running) return;
    live.stopRequested = true;
    const family = familyOf(await processTable(), live.pid);
    signal(live.pid, 'SIGHUP');
    for (const pid of family) if (pid !== live.pid) signal(pid, 'SIGTERM');
    const allGone = () => [...family].every((pid) => !isAlive(pid));
    if (!(await waitUntil(allGone, graceMs))) {
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
    this.serversChanged(sessionId);
  }

  private broadcast(id: string, message: ProcessServerMessage): void {
    const sockets = this.sockets.get(id);
    if (!sockets?.size) return;
    const text = JSON.stringify(message);
    for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.send(text);
  }

  private sendTo(socket: WebSocket, message: ProcessServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }
}
