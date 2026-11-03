import { type UpdateState, UpdateStatus, UpdateWhen } from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../components/ui/markdown';
import { Toggle } from '../components/ui/toggle';
import { useAutoUpdate, useCheckUpdates, useInstallUpdate, useUpdates } from '../lib/queries';
import { ago } from '../monitor/scan-scope';

const RELEASES = 'https://github.com/narrowananth/ops-console/releases';
/** Remembered view: the version whose "Updated" notification the operator closed. */
const NOTICE_KEY = 'ops-console.update-notice';

const v = (version: string) => (version === 'dev' ? 'dev' : `v${version}`);
const newer = (state: UpdateState) =>
  state.latest !== null && state.latest.version !== state.current && state.status !== UpdateStatus.UpToDate;
const runs = (n: number) => `${n} agent ${n === 1 ? 'run' : 'runs'}`;

/**
 * Above the account card while a newer version needs the operator: one to install (auto-update off), one waiting on
 * agent runs, one installing, or one that failed. Auto-update with nothing going shows nothing here.
 */
export function UpdateCard() {
  const state = useUpdates().data?.data;
  const install = useInstallUpdate();
  const [confirming, setConfirming] = useState(false);
  if (!state?.latest) return null;
  const latest = v(state.latest.version);
  const start = (when: UpdateWhen) => {
    setConfirming(false);
    install.mutate(when);
  };

  if (state.status === UpdateStatus.Updating) {
    return (
      <section aria-label="Update" className={card}>
        <div className="flex items-center gap-2 text-xs font-semibold">
          <span
            aria-hidden
            className="size-3 flex-none animate-spin rounded-full border-2 border-accent-300 border-t-accent"
          />
          Updating to {latest}…
        </div>
        <p className="m-0 mt-1 text-xs text-accent-800">
          Downloading, then the console restarts. This page reconnects by itself.
        </p>
      </section>
    );
  }
  if (state.status === UpdateStatus.Waiting) {
    return (
      <section aria-label="Update" className={card}>
        <div className="text-xs font-semibold">{latest} waits for agent runs</div>
        <p className="m-0 mt-1 text-xs text-accent-800">
          It installs once {runs(state.runs_going)} {state.runs_going === 1 ? 'finishes' : 'finish'}.
        </p>
        <div className="mt-2 flex gap-1.5">
          <button
            type="button"
            className={secondary}
            disabled={install.isPending}
            onClick={() => start(UpdateWhen.Now)}
            title="Install now; the agent runs going stop when the console restarts"
          >
            Update now
          </button>
        </div>
      </section>
    );
  }
  if (state.status === UpdateStatus.Failed) {
    return (
      <section aria-label="Update" className={card}>
        <div className="text-xs font-semibold">Update to {latest} failed</div>
        <p role="alert" className="m-0 mt-1 text-xs break-words text-accent-800">
          {state.error}
        </p>
        <div className="mt-2 flex gap-1.5">
          <button type="button" className={primary} disabled={install.isPending} onClick={() => start(UpdateWhen.Idle)}>
            Try again
          </button>
        </div>
      </section>
    );
  }
  if (state.status !== UpdateStatus.Available || state.auto_update) return null;

  return (
    <section aria-label="Update" className={card}>
      <div className="flex items-center justify-between gap-2 text-xs font-semibold">
        Update available
        <span className="rounded-full border border-accent-300 bg-white px-2 py-px font-mono text-xs font-semibold text-accent-700">
          {latest}
        </span>
      </div>
      <p className="m-0 mt-0.5 text-xs text-accent-800">
        You're on {v(state.current)}
        {state.latest.published_at ? ` · released ${ago(state.latest.published_at)}` : ''}
      </p>
      {confirming ? (
        <div role="alert" className="mt-2 rounded-md border border-accent-300 bg-white px-2.5 py-2 text-xs">
          <b>{runs(state.runs_going)} going.</b> They stop when the console restarts.
          <div className="mt-1.5 flex gap-1.5">
            <button type="button" className={primary} onClick={() => start(UpdateWhen.Now)}>
              Update anyway
            </button>
            <button type="button" className={secondary} onClick={() => start(UpdateWhen.Idle)}>
              Wait until idle
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-1.5">
          <button
            type="button"
            className={primary}
            disabled={install.isPending}
            onClick={() => (state.runs_going > 0 ? setConfirming(true) : start(UpdateWhen.Now))}
          >
            Update
          </button>
          <a className={secondary} href={state.latest.url} target="_blank" rel="noreferrer">
            What's new
          </a>
        </div>
      )}
      {install.error && (
        <p role="alert" className="m-0 mt-1.5 text-xs text-accent-700">
          {install.error.message}
        </p>
      )}
    </section>
  );
}

const card = 'rounded-lg border border-accent-300 bg-accent-100 px-3 py-2.5 text-accent-900';
const primary =
  'inline-flex h-7.5 flex-1 cursor-pointer items-center justify-center rounded-md border-0 bg-accent px-2.5 text-xs font-semibold text-white hover:bg-accent-600 disabled:opacity-60';
const secondary =
  'inline-flex h-7.5 cursor-pointer items-center justify-center rounded-md border border-accent-300 bg-white px-2.5 text-xs text-accent-700 no-underline hover:bg-accent-100 hover:text-accent-700 disabled:opacity-60';

/** The installed version under the footer buttons; opens the version panel. */
export function VersionLine({ collapsed }: { collapsed: boolean }) {
  const state = useUpdates().data?.data;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (!state) return null;
  const ready = newer(state);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label="Ops Console version"
        aria-expanded={open}
        title={ready ? `${v(state.latest?.version ?? '')} is out. Opens the version panel.` : 'Opens the version panel'}
        onClick={() => setOpen(!open)}
        className={
          collapsed
            ? 'relative inline-flex h-8.5 w-full cursor-pointer items-center justify-center border border-line bg-card font-mono text-xs text-text hover:bg-neutral-200'
            : 'flex w-full cursor-pointer items-center justify-center gap-1.5 border-0 bg-transparent px-0.5 text-xs text-neutral-700 hover:text-text'
        }
      >
        {collapsed ? (
          <>
            {v(state.current)}
            {ready && (
              <span
                aria-hidden
                className="absolute top-1 right-1.5 size-1.75 rounded-full bg-accent ring-2 ring-card"
              />
            )}
          </>
        ) : (
          <>
            <span className="font-mono font-semibold text-text">{v(state.current)}</span>
            <span aria-hidden>·</span>
            <VersionWord state={state} />
          </>
        )}
      </button>
      {open && <VersionPanel state={state} />}
    </div>
  );
}

function VersionWord({ state }: { state: UpdateState }) {
  switch (state.status) {
    case UpdateStatus.Dev:
      return <span>development build</span>;
    case UpdateStatus.Unknown:
      return <span>checking…</span>;
    case UpdateStatus.UpToDate:
      return <span className="text-ok">✓ Up to date</span>;
    case UpdateStatus.Updating:
      return <span className="text-accent-700">updating…</span>;
    case UpdateStatus.Failed:
      return <span className="text-accent-700">update failed</span>;
    default:
      return <span className="text-accent-700">{v(state.latest?.version ?? '')} ready</span>;
  }
}

/** Installed and latest version, the release notes, Check now, Update automatically and Update. */
function VersionPanel({ state }: { state: UpdateState }) {
  const check = useCheckUpdates();
  const install = useInstallUpdate();
  const auto = useAutoUpdate();
  const dev = state.status === UpdateStatus.Dev;
  const ready = newer(state) && state.status !== UpdateStatus.Updating;
  const latest = state.latest;
  return (
    <div
      role="dialog"
      aria-label="Ops Console version"
      className="absolute bottom-0 left-full z-50 ml-2 flex w-80 flex-col overflow-hidden rounded-xl border border-line bg-card text-xs shadow-lg"
    >
      <header className="flex justify-between border-b border-divider px-4 py-2.5 font-semibold">
        Ops Console <span className="font-mono font-semibold">{v(state.current)}</span>
      </header>
      <dl className="m-0 grid grid-cols-[84px_1fr] gap-x-2.5 gap-y-1.5 px-4 py-3">
        <dt className="text-neutral-700">Installed</dt>
        <dd className="m-0 font-mono">{v(state.current)}</dd>
        <dt className="text-neutral-700">Latest</dt>
        <dd className={`m-0 font-mono ${ready ? 'text-accent-700' : ''}`}>
          {latest ? v(latest.version) : '–'}
          {latest?.published_at ? ` · ${ago(latest.published_at)}` : ''}
        </dd>
        <dt className="text-neutral-700">Checked</dt>
        <dd className="m-0">
          {state.checked_at ? new Date(state.checked_at).toLocaleTimeString([], { timeStyle: 'short' }) : 'not yet'}
          {!dev && (
            <>
              {' · '}
              <button
                type="button"
                disabled={check.isPending}
                onClick={() => check.mutate()}
                className="cursor-pointer border-0 bg-transparent p-0 text-xs text-text underline disabled:opacity-60"
              >
                {check.isPending ? 'Checking…' : 'Check now'}
              </button>
            </>
          )}
        </dd>
      </dl>
      {dev && <p className="m-0 px-4 pb-3 text-neutral-700">A development build does not update itself.</p>}
      {state.error && (
        <p role="alert" className="m-0 px-4 pb-3 text-accent-700">
          {state.error}
        </p>
      )}
      {latest && ready && (
        <div className="mx-4 mb-3 max-h-48 overflow-y-auto rounded-md bg-neutral-200 px-3 py-2.5">
          <div className="mb-1 font-semibold">What's new in {v(latest.version)}</div>
          {latest.notes && <Markdown source={latest.notes} className="text-xs" />}
          <a className="mt-1.5 inline-block" href={latest.url} target="_blank" rel="noreferrer">
            Full release notes ↗
          </a>
        </div>
      )}
      {!dev && (
        <div className="flex items-center justify-between gap-3 border-t border-divider px-4 py-2.5">
          <div>
            <div className="font-semibold">Update automatically</div>
            <div className="text-xs text-neutral-700">Installs new versions when no agent runs</div>
          </div>
          <Toggle label="Update automatically" checked={state.auto_update} onChange={(on) => auto.mutate(on)} />
        </div>
      )}
      {ready && (
        <div className="px-4 pb-3.5">
          <button
            type="button"
            className={`${primary} w-full`}
            disabled={install.isPending}
            onClick={() => install.mutate(state.runs_going > 0 ? UpdateWhen.Idle : UpdateWhen.Now)}
            title={state.runs_going > 0 ? `Installs once ${runs(state.runs_going)} finish` : undefined}
          >
            {state.runs_going > 0
              ? `Update to ${v(latest?.version ?? '')} when idle`
              : `Update to ${v(latest?.version ?? '')}`}
          </button>
        </div>
      )}
    </div>
  );
}

/** Bottom-right, once after the console starts on a new version, until the operator closes it. */
export function UpdateNotice() {
  const state = useUpdates().data?.data;
  const [closed, setClosed] = useState(() => localStorage.getItem(NOTICE_KEY));
  if (!state?.updated || closed === state.current) return null;
  const close = () => {
    localStorage.setItem(NOTICE_KEY, state.current);
    setClosed(state.current);
  };
  const at = new Date(state.updated.at).toLocaleTimeString([], { timeStyle: 'short' });
  return (
    <div
      role="status"
      aria-label="Ops Console updated"
      className="fixed right-5 bottom-5 z-50 flex w-80 items-start gap-2.5 rounded-lg border border-line bg-card px-3.5 py-3 text-xs shadow-lg"
    >
      <span
        aria-hidden
        className="grid size-6.5 flex-none place-items-center rounded-full bg-ok/12 font-semibold text-ok"
      >
        ✓
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold">Updated to {v(state.current)}</div>
        <div className="mt-0.5 text-neutral-700">
          {state.updated.automatic ? `Updated automatically at ${at}` : `From ${v(state.updated.from)} at ${at}`}.{' '}
          <a href={`${RELEASES}/tag/v${state.current}`} target="_blank" rel="noreferrer">
            What's new
          </a>
        </div>
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={close}
        className="cursor-pointer border-0 bg-transparent p-0 text-neutral-700 hover:text-text"
      >
        ✕
      </button>
    </div>
  );
}
