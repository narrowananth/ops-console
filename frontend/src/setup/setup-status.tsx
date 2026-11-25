import { KEYCHAIN_HANDOVER_MESSAGE } from '@ops-console/shared';
import { Button } from '../components/ui/button';
import { useDiskAccess, useKeychainHandover, useOpenDiskAccessSettings, useRunSandbox } from '../lib/queries';

/** Anchor of the Full Disk Access line: the Start button's hint scrolls to it. */
export const DISK_ACCESS_ID = 'full-disk-access';

const PILL = 'rounded-full px-2 py-0.5 font-mono text-xs';

/** What Setup agent needs from this Mac: a line each for Full Disk Access and the Run sandbox, and a refused Keychain handover. */
export function SetupStatus() {
  const handover = useKeychainHandover().data;
  return (
    <div className="flex flex-col gap-2 text-xs">
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        <DiskAccessLine />
        <RunSandboxLine />
      </ul>
      {handover?.refused && (
        <div
          role="alert"
          aria-label="Keychain handover"
          className="flex flex-col gap-0.5 rounded-lg bg-accent-100 px-3 py-2.5 text-accent-700"
        >
          <span>{KEYCHAIN_HANDOVER_MESSAGE}</span>
          <span className="font-mono">{handover.reason}</span>
        </div>
      )}
    </div>
  );
}

/** macOS only: nothing here when the daemon cannot read the state. */
function DiskAccessLine() {
  const access = useDiskAccess();
  const openSettings = useOpenDiskAccessSettings();
  const state = access.data;
  if (!state || state.granted === null) return null;
  const look = state.granted
    ? { label: 'on', className: 'bg-ok/12 text-ok', tip: 'The Setup agent can read the folders it needs.' }
    : state.app_path
      ? {
          label: 'off',
          className: 'bg-accent-100 text-accent-700',
          tip: 'The Setup agent cannot start until you turn this on in System Settings.',
        }
      : {
          label: 'off · dev build',
          className: 'bg-neutral-200 text-neutral-700',
          tip: 'pnpm dev builds no app to grant it to. The Setup agent starts anyway.',
        };
  return (
    <li id={DISK_ACCESS_ID} aria-label="Full Disk Access" className="flex flex-col gap-2 rounded-lg bg-bg px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="flex-1">
          <strong>Full Disk Access:</strong>{' '}
          <span title={look.tip} className={`${PILL} ${look.className}`}>
            {look.label}
          </span>
        </span>
        {!state.granted && state.app_path && (
          <Button variant="primary" className="px-3 py-1.25 text-xs" onClick={() => openSettings.mutate()}>
            Open Settings
          </Button>
        )}
      </div>
      {!state.granted && state.app_path && <GrantSteps appPath={state.app_path} />}
      {openSettings.error && (
        <span role="alert" className="text-accent-700">
          {openSettings.error.message}
        </span>
      )}
    </li>
  );
}

/** Whether agent runs' commands run inside the Run sandbox. Read-only: no Setting turns it off. */
function RunSandboxLine() {
  const sandbox = useRunSandbox();
  const state = sandbox.data;
  const look = !state
    ? { label: '… checking', className: 'bg-neutral-200 text-neutral-700', tip: 'Testing the sandbox.' }
    : state.status === 'on'
      ? {
          label: 'on',
          className: 'bg-ok/12 text-ok',
          tip: 'Agent runs cannot read the login Keychain folder or the installed app, or change git hooks and config.',
        }
      : {
          label: 'unavailable',
          className: 'bg-accent-100 text-accent-700',
          tip: 'Agent runs fail rather than run without the sandbox.',
        };
  return (
    <li aria-label="Run sandbox" className="flex flex-col gap-2 rounded-lg bg-bg px-3 py-2.5">
      <span>
        <strong>Run sandbox:</strong>{' '}
        <span title={look.tip} className={`${PILL} ${look.className}`}>
          {look.label}
        </span>
      </span>
      {state?.status === 'unavailable' && <span className="text-accent-700">{state.reason}</span>}
      {sandbox.error && (
        <span role="alert" className="text-accent-700">
          {sandbox.error.message}
        </span>
      )}
    </li>
  );
}

/** The installed app restarts with `ops-console`; the one `pnpm dev` builds, with `pnpm dev`. */
function GrantSteps({ appPath }: { appPath: string }) {
  const app =
    appPath
      .split('/')
      .pop()
      ?.replace(/\.app$/, '') ?? 'Ops Console';
  return (
    <span className="text-neutral-700">
      Drag {app} from the Finder window into the list and switch it on, then{' '}
      {app.endsWith('(dev)') ? (
        <>
          stop <code>pnpm dev</code> and run it again.
        </>
      ) : (
        <>
          run <code>ops-console stop</code> and <code>ops-console start</code>.
        </>
      )}
    </span>
  );
}
