import type { SessionProcess } from '@ops-console/shared';
import { Fragment, type PointerEvent, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '../components/ui/button';
import { useNow } from '../components/ui/elapsed';
import {
  CloseIcon,
  FolderIcon,
  PlusIcon,
  RestartIcon,
  StopIcon,
  TerminalIcon,
  TrashIcon,
} from '../components/ui/icons';
import { XtermView } from '../components/ui/xterm-view';
import { useProcessAction, useProcesses, useScripts, useStartProcess } from '../lib/queries';
import { useStored } from '../lib/remember';
import { ascending } from '../lib/sort';
import { MenuButton, MenuHeading, MenuItem } from './menu-button';
import { bySource, isRunning, stateLabel, stateSentence, stateTone } from './processes';

/** The dock's height until the operator drags it, and its limits. */
export const TERMINALS_DOCK = { key: 'workspace.session-terminals-height', initial: 260, shortest: 160 };

/** A folder the Session may run in besides its own worktree: an Opened Repo's. */
export type RunFolder = { name: string; path: string };

const TONE = { ok: 'bg-ok', failed: 'bg-accent', idle: 'bg-neutral-400' } as const;

/**
 * The bar above the dock: drag it up for a taller dock, down for a shorter one. The arrow keys do the same.
 */
function HeightHandle({ height, onHeight }: { height: number; onHeight: (height: number) => void }) {
  const start = useRef<{ y: number; height: number } | null>(null);
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current) onHeight(start.current.height + start.current.y - event.clientY);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a horizontal bar that resizes is a separator; <hr> cannot take focus or drags
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the terminals"
      aria-valuenow={height}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { y: event.clientY, height };
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        start.current = null;
      }}
      onDoubleClick={() => onHeight(TERMINALS_DOCK.initial)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') onHeight(height + 32);
        else if (event.key === 'ArrowDown') onHeight(height - 32);
        else return;
        event.preventDefault();
      }}
      className="h-1.5 flex-none cursor-row-resize touch-none border-t border-divider outline-none hover:bg-accent-200 focus-visible:bg-accent-300"
    />
  );
}

/**
 * The Session's processes under the conversation and the browser. A header names the dock and holds one tab per process,
 * a New terminal button, a menu of scripts when the folder has any, and a Hide button. Under it, the selected process
 * says what it runs and in which state, with Stop (while it runs), Restart and Remove (once it has ended). A process runs
 * on when the dock is hidden.
 */
export function TerminalsDock({
  sessionId,
  folders,
  onClose,
}: {
  sessionId: string;
  folders: RunFolder[];
  onClose: () => void;
}) {
  const processes = useProcesses(sessionId, true);
  const scripts = useScripts(sessionId, true);
  const start = useStartProcess(sessionId);
  const act = useProcessAction(sessionId);
  const [stored, setStored] = useStored(TERMINALS_DOCK.key, z.number(), TERMINALS_DOCK.initial);
  const widest = Math.max(TERMINALS_DOCK.shortest, Math.floor(window.innerHeight * 0.7));
  const height = Math.round(Math.min(widest, Math.max(TERMINALS_DOCK.shortest, stored)));
  const [picked, setPicked] = useState<string | null>(null);
  // The folder a new process runs in: null is the Session's own worktree.
  const [folder, setFolder] = useState<string | null>(null);

  const list = processes.data ?? [];
  const current = list.find((one) => one.id === picked) ?? list[0];
  const run = (body: { name: string; script?: string }) =>
    start.mutate(
      { ...body, ...(folder === null ? {} : { folder }) },
      { onSuccess: (process) => setPicked(process.id) },
    );
  const newTerminal = () => run({ name: 'shell' });
  const error = start.error?.message ?? act.error?.message ?? null;
  // The script menu appears once the folder lists scripts, or when reading them failed and the menu says why.
  const hasScripts = scripts.isError || (scripts.data?.scripts.length ?? 0) > 0;
  const folderName =
    folder === null ? "This Session's folder" : (folders.find((one) => one.path === folder)?.name ?? folder);

  return (
    <section aria-label="Terminals" style={{ height }} className="@container flex flex-none flex-col bg-bg">
      <HeightHandle
        height={height}
        onHeight={(next) => setStored(Math.min(widest, Math.max(TERMINALS_DOCK.shortest, Math.round(next))))}
      />
      <div className="flex flex-none flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-line bg-surface px-2.5 py-1.5">
        <h3 className="m-0 flex flex-none items-center gap-1.5 pr-1 text-xs font-semibold text-text">
          <TerminalIcon />
          Terminals
        </h3>
        <div
          role="tablist"
          aria-label="Processes"
          className="order-last flex w-full min-w-0 items-center gap-1 overflow-x-auto @md:order-none @md:w-auto @md:flex-1"
        >
          {list.map((process) => (
            <ProcessTab
              key={process.id}
              process={process}
              selected={process.id === current?.id}
              onPick={() => setPicked(process.id)}
            />
          ))}
        </div>
        <span className="ml-auto flex-none @md:hidden" />
        <Button
          className="flex-none rounded-lg px-2.5 py-1 text-xs"
          disabled={start.isPending}
          aria-label="New terminal"
          title="Open a new terminal: a shell you type commands in"
          onClick={newTerminal}
        >
          <PlusIcon />
          <span className="hidden @sm:inline">New terminal</span>
        </Button>
        {hasScripts && (
          <MenuButton
            label="Run a script"
            opens="up"
            width="w-72"
            title="Run one of this folder's scripts, such as dev or test"
            menuChildren={(close) =>
              folder !== null ? (
                <p className="m-0 px-2.5 py-1.5 text-xs text-neutral-700">
                  Scripts are listed for this Session's folder only. Pick it as the folder to run one.
                </p>
              ) : scripts.isError ? (
                <p role="alert" className="m-0 px-2.5 py-1.5 text-xs text-accent-700">
                  Could not read the scripts: {scripts.error.message}
                </p>
              ) : (
                bySource(scripts.data?.scripts ?? []).map(([source, group]) => (
                  <Fragment key={source}>
                    <MenuHeading>{source}</MenuHeading>
                    {group.map((script) => (
                      <MenuItem
                        key={script.id}
                        title={script.command || script.run}
                        hint={script.run}
                        onClick={() => {
                          close();
                          run({ name: script.name, script: script.id });
                        }}
                      >
                        {script.name}
                      </MenuItem>
                    ))}
                  </Fragment>
                ))
              )
            }
          >
            <span>Run a script</span>
            <span aria-hidden className="text-neutral-600">
              ▾
            </span>
          </MenuButton>
        )}
        {folders.length > 0 && (
          <MenuButton
            label="Folder"
            opens="up"
            width="w-64"
            title={`The folder new terminals and scripts run in: ${folderName}`}
            menuChildren={() => (
              <>
                <MenuHeading>Run in</MenuHeading>
                <MenuItem selected={folder === null} onClick={() => setFolder(null)}>
                  This Session's folder
                </MenuItem>
                {ascending(folders, (one) => one.name).map((one) => (
                  <MenuItem
                    key={one.path}
                    selected={folder === one.path}
                    title={one.path}
                    onClick={() => setFolder(one.path)}
                  >
                    {one.name}
                  </MenuItem>
                ))}
              </>
            )}
          >
            <FolderIcon size={14} />
            <span className="hidden max-w-32 truncate @xl:inline">{folderName}</span>
            <span aria-hidden className="text-neutral-600">
              ▾
            </span>
          </MenuButton>
        )}
        <button
          type="button"
          aria-label="Hide terminals"
          title="Hide terminals. Processes keep running."
          onClick={onClose}
          className="flex size-7 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-neutral-700 hover:bg-neutral-200 hover:text-text"
        >
          <CloseIcon />
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="m-0 border-b border-line px-3 py-1.5 text-xs text-accent-700">
          {error}
        </p>
      )}
      {current !== undefined && (
        <ProcessBar process={current} busy={act.isPending} onAct={(action) => act.mutate({ id: current.id, action })} />
      )}
      {current !== undefined && current.prod_connections.length > 0 && (
        <p role="status" className="m-0 border-b border-line bg-accent-100 px-3 py-1.5 text-xs text-accent-900">
          This folder's .env names the PROD Connection{current.prod_connections.length > 1 ? 's' : ''}{' '}
          {current.prod_connections.join(', ')}. The process can reach{' '}
          {current.prod_connections.length > 1 ? 'them' : 'it'}.
        </p>
      )}
      {processes.isPending ? (
        <p className="m-0 px-4 py-3 text-xs text-neutral-700">Reading the processes…</p>
      ) : processes.isError ? (
        <p role="alert" className="m-0 px-4 py-3 text-xs text-accent-700">
          Could not read the processes: {processes.error.message}
        </p>
      ) : current === undefined ? (
        <NoTerminals busy={start.isPending} onNew={newTerminal} />
      ) : (
        // Every process keeps its view, stacked in one box, so a tab switch shows the screen as it was instead of
        // reading the output again. A restart is a new run: its view attaches again and reads its output from the start.
        <div className="relative min-h-0 flex-1">
          {list.map((one) => (
            <XtermView
              key={`${one.id}:${one.started_at}`}
              path={`/processes/${one.id}`}
              interactive
              hidden={one.id !== current.id}
              className="absolute inset-0 p-2.5"
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** What a terminal is for, shown while the Session has none, with the one button that makes the first. */
function NoTerminals({ busy, onNew }: { busy: boolean; onNew: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div className="m-auto flex max-w-md items-start gap-3">
        <span
          aria-hidden
          className="flex size-9 flex-none items-center justify-center rounded-xl border border-line bg-surface text-neutral-700"
        >
          <TerminalIcon />
        </span>
        <div className="flex min-w-0 flex-col items-start gap-2">
          <div>
            <h4 className="m-0 text-[13px] font-semibold">No terminals yet</h4>
            <p className="m-0 mt-0.5 text-xs text-neutral-700">
              A terminal runs a command for this Session: a dev server, a test watch or a shell. It keeps running when
              you hide this panel.
            </p>
          </div>
          <Button variant="primary" className="rounded-lg px-3 py-1.5 text-xs" disabled={busy} onClick={onNew}>
            <PlusIcon />
            New terminal
          </Button>
          <p className="m-0 text-xs text-neutral-600">e.g. run your dev server. Its page opens in the Browser panel.</p>
        </div>
      </div>
    </div>
  );
}

const ACTION =
  'flex h-7 min-w-7 flex-none cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-line bg-card px-1.5 text-xs text-text transition-colors hover:border-neutral-400 disabled:cursor-not-allowed disabled:opacity-50';

/**
 * The selected process: what it runs, where, and its state in a sentence, with the buttons that act on it. Stop shows
 * while it runs; Remove shows once it has ended.
 */
function ProcessBar({
  process,
  busy,
  onAct,
}: {
  process: SessionProcess;
  busy: boolean;
  onAct: (action: 'stop' | 'restart' | 'close') => void;
}) {
  const running = isRunning(process);
  const now = useNow(running);
  const actions = [
    running
      ? { action: 'stop' as const, label: 'Stop', title: 'Stop this process', icon: <StopIcon /> }
      : {
          action: 'close' as const,
          label: 'Remove',
          title: 'Remove this process and its output from the list',
          icon: <TrashIcon />,
        },
    { action: 'restart' as const, label: 'Restart', title: 'Run the same command again', icon: <RestartIcon /> },
  ];
  return (
    <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-3 py-1.5">
      <div className="flex min-w-48 flex-1 flex-col gap-0.5">
        <p className="m-0 flex items-center gap-2 text-xs font-semibold">
          <span aria-hidden className={`size-2 flex-none rounded-full ${TONE[stateTone(process)]}`} />
          {stateSentence(process, now)}
        </p>
        <p
          className="m-0 flex min-w-0 gap-1.5 text-xs text-neutral-700"
          title={`${process.command || 'shell'} in ${process.folder}`}
        >
          <span className="max-w-[55%] flex-none truncate font-mono">{process.command || 'Shell'}</span>
          <span aria-hidden className="flex-none">
            in
          </span>
          <span className="min-w-0 truncate font-mono">{process.folder}</span>
        </p>
      </div>
      <div className="flex flex-none items-center gap-1.5">
        {actions.map(({ action, label, title, icon }) => (
          <button
            key={action}
            type="button"
            aria-label={label}
            title={title}
            disabled={busy}
            onClick={() => onAct(action)}
            className={ACTION}
          >
            {icon}
            <span className="hidden @lg:inline">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ProcessTab({ process, selected, onPick }: { process: SessionProcess; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      title={`${process.command || 'shell'} in ${process.folder}`}
      onClick={onPick}
      className={`flex max-w-56 flex-none cursor-pointer items-center gap-2 rounded-md border-0 px-2.5 py-1 text-xs ${
        selected
          ? 'bg-accent-100 font-semibold text-accent-900'
          : 'bg-transparent text-neutral-700 hover:bg-neutral-200'
      }`}
    >
      <span aria-hidden className={`size-2 flex-none rounded-full ${TONE[stateTone(process)]}`} />
      <span className="min-w-0 truncate">{process.name}</span>
      <span className="flex-none text-[10px] font-normal text-neutral-600">{stateLabel(process)}</span>
    </button>
  );
}
