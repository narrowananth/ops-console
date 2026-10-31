import { Logo } from '../app/top-bar';
import { Button } from '../components/ui/button';
import {
  useCloseSetupTerminal,
  useDiskAccess,
  useOpenDiskAccessSettings,
  useSetupTerminal,
  useStartSetupTerminal,
} from '../lib/queries';
import { SetupTerminal } from './setup-terminal';

/** Settings › Setup agent: Claude, in a terminal, setting up what the other tabs hold from the operator's words. */
export function SetupAgentTab() {
  const start = useStartSetupTerminal();
  const close = useCloseSetupTerminal();
  const terminal = useSetupTerminal().data ?? null;
  const access = useDiskAccess().data;
  // The installed app starts only with Full Disk Access on; under `pnpm dev` there is no app entry to switch on.
  const locked = access?.granted === false && access.app_path !== null;
  return (
    <div>
      <Permissions locked={locked && !terminal} />
      {!terminal && (
        <div className="flex justify-end border-b-2 border-divider px-5 py-3">
          <Button variant="primary" disabled={start.isPending || locked} onClick={() => start.mutate()}>
            Start setup agent
          </Button>
        </div>
      )}
      {start.error && (
        <div role="alert" className="px-5 py-2 text-xs text-accent-700">
          {start.error.message}
        </div>
      )}
      {terminal && <SetupTerminal terminalId={terminal} onClose={() => close.mutate(terminal)} />}
    </div>
  );
}

/** What macOS asks before the Setup agent reads this machine, one row each with where it stands. macOS only. */
function Permissions({ locked }: { locked: boolean }) {
  const access = useDiskAccess();
  const openSettings = useOpenDiskAccessSettings();
  const state = access.data;
  if (!state || state.granted === null) return null;
  const disk = state.granted
    ? { glyph: '● on', className: 'text-text' }
    : state.app_path
      ? { glyph: '✕ off', className: 'text-accent-700' }
      : { glyph: '○ off · dev build', className: 'text-neutral-700' };
  return (
    <section aria-label="Permissions" className="flex flex-col gap-2 border-b border-divider px-5 py-3 text-xs">
      <div className="flex items-center gap-2">
        <Logo size={20} />
        <strong>Permissions</strong>
        {locked && <span className="text-accent-700">Turn these on to start the Setup agent.</span>}
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        <li aria-label="Full Disk Access" className="flex items-center gap-3 border-t border-divider py-1.5">
          <span className="flex-1">
            <strong>Full Disk Access</strong>
            <span className="text-neutral-700"> · reads every folder on this Mac</span>
          </span>
          <span className={`font-mono ${disk.className}`}>{disk.glyph}</span>
          {!state.granted && state.app_path && (
            <Button variant="primary" className="px-2.5 py-1 text-xs" onClick={() => openSettings.mutate()}>
              Open System Settings
            </Button>
          )}
          {!state.granted && (
            <Button
              variant="ghost"
              className="px-2.5 py-1 text-xs"
              disabled={access.isFetching}
              onClick={() => access.refetch()}
            >
              Check again
            </Button>
          )}
        </li>
        {!state.granted && state.app_path && (
          <li className="pb-1.5 text-neutral-700">
            Drag Ops Console from the Finder window into the list and switch it on, then run{' '}
            <code>ops-console stop</code> and <code>ops-console start</code>.
          </li>
        )}
        <li aria-label="Keychain" className="flex items-center gap-3 border-t border-divider py-1.5">
          <span className="flex-1">
            <strong>Keychain</strong>
            <span className="text-neutral-700"> · macOS asks before each saved password</span>
          </span>
          <span className="font-mono text-neutral-700">◐ asks each time</span>
        </li>
      </ul>
      {openSettings.error && (
        <div role="alert" className="text-accent-700">
          {openSettings.error.message}
        </div>
      )}
    </section>
  );
}
