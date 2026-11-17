import type { SessionProcess } from '@ops-console/shared';
import { type PointerEvent, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '../components/ui/button';
import { XtermView } from '../components/ui/xterm-view';
import { useProcessAction, useProcesses, useScripts, useStartProcess } from '../lib/queries';
import { useStored } from '../lib/remember';
import { ascending } from '../lib/sort';
import { MenuButton, MenuHeading, MenuItem, MenuRule } from './menu-button';
import { isRunning, scriptCommand, stateLabel, stateTone } from './processes';

/** The dock's height until the operator drags it, and its limits. */
export const TERMINALS_DOCK = { key: 'workspace.session-terminals-height', initial: 260, shortest: 120 };

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
 * The Session's processes under the conversation and the browser: one terminal each, with its state, a Run menu for
 * scripts and a shell, and Stop, Restart and Close. A process runs on when the dock closes.
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
  const error = start.error?.message ?? act.error?.message ?? null;

  return (
    <section aria-label="Terminals" style={{ height }} className="flex flex-none flex-col bg-bg">
      <HeightHandle
        height={height}
        onHeight={(next) => setStored(Math.min(widest, Math.max(TERMINALS_DOCK.shortest, Math.round(next))))}
      />
      <div className="flex flex-none items-center gap-1.5 border-b border-line bg-surface px-2.5 py-1.5">
        <div role="tablist" aria-label="Processes" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {list.map((process) => (
            <ProcessTab
              key={process.id}
              process={process}
              selected={process.id === current?.id}
              onPick={() => setPicked(process.id)}
            />
          ))}
        </div>
        <MenuButton
          label="Run"
          opens="up"
          width="w-72"
          title="Run a script or open a terminal"
          menuChildren={(close) => (
            <>
              {folders.length > 0 && (
                <>
                  <MenuHeading>Folder</MenuHeading>
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
                  <MenuRule />
                </>
              )}
              <MenuHeading>Scripts</MenuHeading>
              {folder !== null ? (
                <p className="m-0 px-2.5 py-1.5 text-xs text-neutral-700">
                  Scripts are listed for this Session's folder only. Open a terminal here instead.
                </p>
              ) : scripts.isPending ? (
                <p className="m-0 px-2.5 py-1.5 text-xs text-neutral-700">Reading package.json…</p>
              ) : scripts.isError ? (
                <p role="alert" className="m-0 px-2.5 py-1.5 text-xs text-accent-700">
                  Could not read the scripts: {scripts.error.message}
                </p>
              ) : scripts.data.scripts.length === 0 ? (
                <p className="m-0 px-2.5 py-1.5 text-xs text-neutral-700">No scripts in package.json.</p>
              ) : (
                ascending(scripts.data.scripts, (one) => one.name).map((script) => (
                  <MenuItem
                    key={script.name}
                    title={script.command}
                    hint={scriptCommand(scripts.data.runner, script.name)}
                    onClick={() => {
                      close();
                      run({ name: script.name, script: script.name });
                    }}
                  >
                    {script.name}
                  </MenuItem>
                ))
              )}
              <MenuRule />
              <MenuItem
                onClick={() => {
                  close();
                  run({ name: 'shell' });
                }}
              >
                New terminal
              </MenuItem>
            </>
          )}
        >
          Run <span aria-hidden>▴</span>
        </MenuButton>
        {current && (
          <>
            <Button
              className="px-2.5 py-1 text-xs"
              disabled={!isRunning(current) || act.isPending}
              title="Stop this process"
              onClick={() => act.mutate({ id: current.id, action: 'stop' })}
            >
              Stop
            </Button>
            <Button
              className="px-2.5 py-1 text-xs"
              disabled={act.isPending}
              title="Start the same command again"
              onClick={() => act.mutate({ id: current.id, action: 'restart' })}
            >
              Restart
            </Button>
            <Button
              className="px-2.5 py-1 text-xs"
              disabled={isRunning(current) || act.isPending}
              title={isRunning(current) ? 'Stop it first' : 'Remove this process and its output'}
              onClick={() => act.mutate({ id: current.id, action: 'close' })}
            >
              Close
            </Button>
          </>
        )}
        <button
          type="button"
          aria-label="Close the terminals"
          title="Close the dock. Processes keep running."
          onClick={onClose}
          className="cursor-pointer rounded-md border-0 bg-transparent px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-200 hover:text-text"
        >
          ×
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="m-0 border-b border-line px-3 py-1.5 text-xs text-accent-700">
          {error}
        </p>
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
        <p className="m-0 px-4 py-3 text-[13px] text-neutral-700">No process. Run a script or open a terminal.</p>
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

function ProcessTab({ process, selected, onPick }: { process: SessionProcess; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      title={`${process.command || 'shell'} in ${process.folder}`}
      onClick={onPick}
      className={`flex max-w-64 flex-none cursor-pointer items-center gap-2 rounded-md border-0 px-2.5 py-1 text-xs ${
        selected
          ? 'bg-accent-100 font-semibold text-accent-900'
          : 'bg-transparent text-neutral-700 hover:bg-neutral-200'
      }`}
    >
      <span aria-hidden className={`size-2 flex-none rounded-full ${TONE[stateTone(process)]}`} />
      <span className="flex-none">{process.name}</span>
      <span className="min-w-0 truncate font-mono text-[10px] font-normal text-neutral-600">
        {isRunning(process) ? process.command : stateLabel(process)}
      </span>
    </button>
  );
}
