import type { SessionProcess } from '@ops-console/shared';
import { Fragment, type PointerEvent, type ReactNode, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '../components/ui/button';
import { useNow } from '../components/ui/elapsed';
import {
  ChevronIcon,
  CloseIcon,
  MaximizeIcon,
  PlusIcon,
  RestartIcon,
  RestoreIcon,
  SplitIcon,
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

/** A bare icon button of the toolbar: a tooltip and an accessible name, no text. */
function IconButton({
  label,
  title,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-neutral-700 transition-colors hover:bg-neutral-200 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** The groups the operator split, each a row of process ids; every other process is a group of its own. */
function groupsOf(split: string[][], list: SessionProcess[]): string[][] {
  const alive = new Set(list.map((one) => one.id));
  const kept = split.map((group) => group.filter((id) => alive.has(id))).filter((group) => group.length > 0);
  const placed = new Set(kept.flat());
  return [...kept, ...list.filter((one) => !placed.has(one.id)).map((one) => [one.id])];
}

/**
 * The Session's processes under the conversation and the browser, laid out as an editor's terminal panel. One bar of
 * icons: the selected process's name and state, New terminal (+) with a menu for scripts and the folder, Split, Restart,
 * Stop (while it runs) or Remove (once it ended), Maximize and Hide. Split puts a new shell beside the selected one; a
 * list of the processes shows at the right from the second on. A process runs on when the dock is hidden.
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
  const [maximized, setMaximized] = useState(false);
  const height = maximized ? widest : Math.round(Math.min(widest, Math.max(TERMINALS_DOCK.shortest, stored)));
  const [picked, setPicked] = useState<string | null>(null);
  const [split, setSplit] = useState<string[][]>([]);
  // The folder a new process runs in: null is the Session's own worktree.
  const [folder, setFolder] = useState<string | null>(null);

  const list = processes.data ?? [];
  const current = list.find((one) => one.id === picked) ?? list[0];
  const groups = groupsOf(split, list);
  const shown = groups.find((group) => current !== undefined && group.includes(current.id)) ?? [];
  const run = (body: { name: string; script?: string }, beside = false) =>
    start.mutate(
      { ...body, ...(folder === null ? {} : { folder }) },
      {
        onSuccess: (process) => {
          setPicked(process.id);
          if (beside && current !== undefined) {
            setSplit(groups.map((group) => (group.includes(current.id) ? [...group, process.id] : group)));
          }
        },
      },
    );
  const newTerminal = () => run({ name: 'shell' });
  const error = start.error?.message ?? act.error?.message ?? null;
  // The menu appears once the folder lists scripts, or when reading them failed and the menu says why, or with folders to pick.
  const hasScripts = scripts.isError || (scripts.data?.scripts.length ?? 0) > 0;
  const folderName =
    folder === null ? "This Session's folder" : (folders.find((one) => one.path === folder)?.name ?? folder);
  const running = current !== undefined && isRunning(current);
  const now = useNow(running);

  return (
    <section aria-label="Terminals" style={{ height }} className="@container flex flex-none flex-col bg-bg">
      <HeightHandle
        height={height}
        onHeight={(next) => {
          setMaximized(false);
          setStored(Math.min(widest, Math.max(TERMINALS_DOCK.shortest, Math.round(next))));
        }}
      />
      <div className="flex flex-none items-center gap-0.5 border-b border-line bg-surface px-2 py-1">
        <h3 className="m-0 mr-2 flex flex-none items-center gap-1.5 text-xs font-semibold text-text">
          <TerminalIcon />
          <span className="hidden @sm:inline">Terminals</span>
        </h3>
        <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5 pr-1.5 text-xs text-neutral-700">
          {current !== undefined && (
            <span
              className="flex min-w-0 items-center gap-1.5"
              title={`${stateSentence(current, now)}. ${current.command || 'shell'} in ${current.folder}`}
            >
              <span aria-hidden className={`size-2 flex-none rounded-full ${TONE[stateTone(current)]}`} />
              <span className="min-w-0 truncate font-mono">{current.name}</span>
              {!running && <span className="flex-none text-[10px] text-neutral-600">{stateLabel(current)}</span>}
            </span>
          )}
        </span>
        <IconButton
          label="New terminal"
          title="New terminal: a shell you type commands in"
          disabled={start.isPending}
          onClick={newTerminal}
        >
          <PlusIcon />
        </IconButton>
        {(hasScripts || folders.length > 0) && (
          <MenuButton
            label="Scripts and folder"
            icon
            opens="up"
            width="w-72"
            title={`Run a script, or pick the folder new terminals run in: ${folderName}`}
            menuChildren={(close) => (
              <>
                {folders.length > 0 && (
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
                {folder !== null ? (
                  <p className="m-0 px-2.5 py-1.5 text-xs text-neutral-700">
                    Scripts are listed for this Session's folder only. Pick it to run one.
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
                )}
              </>
            )}
          >
            <ChevronIcon />
          </MenuButton>
        )}
        {current !== undefined && (
          <>
            <IconButton
              label="Split terminal"
              title="Split: a new shell beside this one"
              disabled={start.isPending}
              onClick={() => run({ name: 'shell' }, true)}
            >
              <SplitIcon />
            </IconButton>
            <IconButton
              label="Restart"
              title="Run the same command again"
              disabled={act.isPending}
              onClick={() => act.mutate({ id: current.id, action: 'restart' })}
            >
              <RestartIcon />
            </IconButton>
            {running ? (
              <IconButton
                label="Stop"
                title="Stop this process"
                disabled={act.isPending}
                onClick={() => act.mutate({ id: current.id, action: 'stop' })}
              >
                <StopIcon />
              </IconButton>
            ) : (
              <IconButton
                label="Remove"
                title="Remove this process and its output from the list"
                disabled={act.isPending}
                onClick={() => act.mutate({ id: current.id, action: 'close' })}
              >
                <TrashIcon />
              </IconButton>
            )}
          </>
        )}
        <span aria-hidden className="mx-1 h-4 w-px flex-none bg-line" />
        <IconButton
          label={maximized ? 'Restore terminals' : 'Maximize terminals'}
          onClick={() => setMaximized((was) => !was)}
        >
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </IconButton>
        <IconButton label="Hide terminals" title="Hide terminals. Processes keep running." onClick={onClose}>
          <CloseIcon />
        </IconButton>
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
        <NoTerminals busy={start.isPending} onNew={newTerminal} />
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Every process keeps its view, stacked in one box, so a switch shows the screen as it was instead of reading
              the output again. The group on show lays its views side by side. A restart is a new run: its view attaches
              again and reads its output from the start. */}
          <div className="relative min-w-0 flex-1">
            {list.map((one) => {
              const slot = shown.indexOf(one.id);
              const on = slot >= 0;
              return (
                <div
                  key={`${one.id}:${one.started_at}`}
                  onMouseDownCapture={() => setPicked(one.id)}
                  style={
                    on
                      ? { left: `${(slot / shown.length) * 100}%`, width: `${100 / shown.length}%` }
                      : { left: 0, width: '100%' }
                  }
                  className={`absolute inset-y-0 ${on && slot > 0 ? 'border-l border-line' : ''} ${
                    on && shown.length > 1 && one.id === current.id ? 'border-t-2 border-t-accent' : ''
                  }`}
                >
                  <XtermView
                    path={`/processes/${one.id}`}
                    interactive
                    hidden={!on}
                    className="absolute inset-0 p-2.5"
                  />
                </div>
              );
            })}
          </div>
          {list.length > 1 && (
            <div
              role="tablist"
              aria-label="Processes"
              aria-orientation="vertical"
              className="flex w-40 flex-none flex-col gap-px overflow-y-auto border-l border-line bg-surface py-1"
            >
              {groups.map((group) =>
                group.map((id, index) => {
                  const one = list.find((process) => process.id === id);
                  return one === undefined ? null : (
                    <ProcessRow
                      key={id}
                      process={one}
                      selected={one.id === current.id}
                      glyph={group.length === 1 ? null : index === 0 ? '┌' : index === group.length - 1 ? '└' : '├'}
                      onPick={() => setPicked(one.id)}
                    />
                  );
                }),
              )}
            </div>
          )}
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

/** A process in the list at the right: its state dot, its name and, in a split group, the tree line that joins it. */
function ProcessRow({
  process,
  selected,
  glyph,
  onPick,
}: {
  process: SessionProcess;
  selected: boolean;
  glyph: string | null;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={`${process.name}, ${stateLabel(process)}`}
      title={`${process.command || 'shell'} in ${process.folder}`}
      onClick={onPick}
      className={`flex w-full cursor-pointer items-center gap-1.5 border-0 px-2.5 py-1 text-left text-xs ${
        selected
          ? 'bg-accent-100 font-semibold text-accent-900'
          : 'bg-transparent text-neutral-700 hover:bg-neutral-200'
      }`}
    >
      <span aria-hidden className="w-2.5 flex-none font-mono text-neutral-500">
        {glyph}
      </span>
      <span aria-hidden className={`size-2 flex-none rounded-full ${TONE[stateTone(process)]}`} />
      <span className="min-w-0 truncate">{process.name}</span>
    </button>
  );
}
