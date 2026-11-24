import { KEYCHAIN_HANDOVER_MESSAGE, KEYCHAIN_WAIT_MESSAGE, LINGER_COMMAND } from '@ops-console/shared';
import type { ReactNode } from 'react';
import { Logo } from '../app/sidebar';
import { Button } from '../components/ui/button';
import {
  useDiskAccess,
  useKeychainAvailability,
  useKeychainHandover,
  useKeychainWait,
  useOpenDiskAccessSettings,
  useOpenLoginItemsSettings,
  useRunSandbox,
  useStartAtLogin,
} from '../lib/queries';

/** What this machine lets the console do, and what an agent run's commands can reach: one row each with where it stands. */
export function PermissionsTab() {
  return (
    <div className="flex min-h-0 flex-1 overflow-auto">
      <section aria-label="Permissions" className="mx-auto flex w-full max-w-180 flex-col gap-5 px-8 py-7">
        <SystemCard />
        <Card
          title={
            <>
              <ShieldIcon />
              <strong>Agent runs</strong>
            </>
          }
        >
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            <RunSandboxRow />
          </ul>
        </Card>
      </section>
    </div>
  );
}

function Card({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-card px-4.5 py-4 text-xs shadow-sm">
      <div className="flex items-center gap-2 text-[13px]">{title}</div>
      {children}
    </section>
  );
}

function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" />
    </svg>
  );
}

/**
 * Full Disk Access (macOS only), Start at login and Keychain: the Secret Service on Linux. Nothing here until the
 * daemon has read the state.
 */
function SystemCard() {
  const access = useDiskAccess();
  const openSettings = useOpenDiskAccessSettings();
  const state = access.data;
  if (!state) return null;
  const mac = state.granted !== null;
  const disk = state.granted
    ? { glyph: '● on', className: 'bg-ok/12 text-ok', tip: 'The Setup agent can read the folders it needs.' }
    : state.app_path
      ? {
          glyph: '✕ off',
          className: 'bg-accent-100 text-accent-700',
          tip: 'The Setup agent cannot start until you turn this on in System Settings.',
        }
      : {
          glyph: '○ off · dev build',
          className: 'bg-neutral-200 text-neutral-700',
          tip: 'pnpm dev builds no app to grant it to. The Setup agent starts anyway.',
        };
  return (
    <Card
      title={
        <>
          <Logo size={20} />
          <strong>{mac ? 'On this Mac' : 'On this machine'}</strong>
        </>
      }
    >
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {mac && (
          <li aria-label="Full Disk Access" className="flex flex-col gap-2 rounded-lg bg-bg px-3 py-2.5">
            <div className="flex items-center gap-2">
              <strong className="flex-1">Full Disk Access</strong>
              <span title={disk.tip} className={`rounded-full px-2 py-0.5 font-mono text-xs ${disk.className}`}>
                {disk.glyph}
              </span>
            </div>
            <span className="text-neutral-700">Reads every folder on this Mac.</span>
            {!state.granted && state.app_path && <GrantSteps appPath={state.app_path} />}
            {!state.granted && (
              <div className="flex gap-2">
                {state.app_path && (
                  <Button variant="primary" className="px-3 py-1.25 text-xs" onClick={() => openSettings.mutate()}>
                    Open System Settings
                  </Button>
                )}
                <Button
                  className="px-3 py-1.25 text-xs"
                  title="Read the permission again after you change it in System Settings"
                  disabled={access.isFetching}
                  onClick={() => access.refetch()}
                >
                  Check again
                </Button>
              </div>
            )}
          </li>
        )}
        <StartAtLoginRow />
        <KeychainRow />
      </ul>
      {openSettings.error && (
        <div role="alert" className="text-accent-700">
          {openSettings.error.message}
        </div>
      )}
    </Card>
  );
}

/** Whether agent runs' commands run inside the Run sandbox. Read-only: no Setting turns it off. */
function RunSandboxRow() {
  const sandbox = useRunSandbox();
  const linux = useKeychainAvailability().data?.store === 'secret_service';
  const state = sandbox.data;
  const on = state?.status === 'on';
  const look = !state
    ? { glyph: '… checking', className: 'bg-neutral-200 text-neutral-700', tip: 'Testing the sandbox.' }
    : on
      ? {
          glyph: '● on',
          className: 'bg-ok/12 text-ok',
          tip: linux
            ? 'Agent runs cannot read the Secret Service or the installed app, or change git hooks and config.'
            : 'Agent runs cannot read the login Keychain folder or the installed app, or change git hooks and config.',
        }
      : {
          glyph: '✕ unavailable',
          className: 'bg-accent-100 text-accent-700',
          tip: 'Agent runs fail rather than run without the sandbox.',
        };
  return (
    <li aria-label="Run sandbox" className="flex flex-col gap-2 rounded-lg bg-bg px-3 py-2.5">
      <div className="flex items-center gap-2">
        <strong className="flex-1">Run sandbox</strong>
        <span title={look.tip} className={`rounded-full px-2 py-0.5 font-mono text-xs ${look.className}`}>
          {look.glyph}
        </span>
      </div>
      <span className="text-neutral-700">
        {linux
          ? "Keeps an agent run's commands out of the Secret Service. What they can reach on localhost and with Docker is not settled on Linux yet."
          : "Keeps an agent run's commands out of the login Keychain. They write anywhere, reach any host and use localhost, as in your terminal."}
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

/**
 * macOS asks before each saved password; a question left unanswered holds up the runs that need it. On Linux the
 * Secret Service keeps them, and none running means no secret can be saved.
 */
function KeychainRow() {
  const read = useKeychainWait();
  const handover = useKeychainHandover();
  const availability = useKeychainAvailability().data;
  const linux = availability?.store === 'secret_service';
  const missing = availability?.available === false;
  const refused = handover.data?.refused === true;
  const failure = read.error ?? handover.error;
  const wait = read.data;
  const waiting = wait?.waiting === true;
  const since = wait?.since ? new Date(wait.since).toLocaleTimeString([], { timeStyle: 'short' }) : null;
  return (
    <li aria-label="Keychain" className="flex flex-col gap-2 rounded-lg bg-bg px-3 py-2.5">
      <div className="flex items-center gap-2">
        <strong className="flex-1">Keychain</strong>
        <span
          title={
            missing
              ? 'No secret can be saved until a Secret Service runs in this login session.'
              : waiting
                ? `${linux ? 'The keyring is asking to be unlocked' : 'The Mac is asking for the login password'}. Runs that need a secret fail if it stays unanswered.`
                : linux
                  ? 'The Secret Service keeps the console’s saved secrets.'
                  : 'macOS asks each time the console reads a saved password.'
          }
          className={`rounded-full px-2 py-0.5 font-mono text-xs ${waiting || missing ? 'bg-accent-100 text-accent-700' : 'bg-neutral-200 text-neutral-700'}`}
        >
          {read.isPending
            ? '… checking'
            : missing
              ? '✕ unavailable'
              : waiting
                ? `◐ waiting since ${since}`
                : linux
                  ? '● Secret Service'
                  : '◐ asks each time'}
        </span>
      </div>
      <span className="text-neutral-700">
        {missing
          ? 'No Secret Service is running, so the console saves no secrets. Log in to a desktop session with a keyring such as GNOME Keyring or KWallet.'
          : waiting
            ? `${KEYCHAIN_WAIT_MESSAGE}. Answer it on ${linux ? 'the desktop' : 'the Mac'}.`
            : linux
              ? 'The desktop keyring holds every saved secret and may ask to be unlocked.'
              : 'macOS asks before each saved password.'}
      </span>
      {missing && <span className="font-mono text-xs text-accent-700">{availability?.reason}</span>}
      {refused && (
        <div className="flex flex-col gap-0.5 text-accent-700">
          <span>{KEYCHAIN_HANDOVER_MESSAGE}</span>
          <span className="font-mono text-xs">{handover.data?.reason}</span>
        </div>
      )}
      {failure && (
        <span role="alert" className="text-accent-700">
          {failure.message}
        </span>
      )}
    </li>
  );
}

/**
 * Whether launchd starts the daemon at login, as macOS shows it under App Background Activity. Only the installed app
 * does; `pnpm dev` runs the console while it runs.
 */
function StartAtLoginRow() {
  const login = useStartAtLogin();
  const openSettings = useOpenLoginItemsSettings();
  const state = login.data;
  if (!state || state.on === null) return null;
  const systemd = state.manager === 'systemd';
  const look = state.dev_build
    ? {
        glyph: '○ off · dev build',
        className: 'bg-neutral-200 text-neutral-700',
        tip: 'pnpm dev runs the console only while it runs. The installed app starts at login.',
      }
    : state.on
      ? {
          glyph: '● on',
          className: 'bg-ok/12 text-ok',
          tip: 'Ops Console starts when you log in, and starts again if it stops.',
        }
      : {
          glyph: '✕ off',
          className: 'bg-accent-100 text-accent-700',
          tip: 'Ops Console does not start when you log in. No scheduled Scan runs while it is stopped.',
        };
  return (
    <li aria-label="Start at login" className="flex flex-col gap-2 rounded-lg bg-bg px-3 py-2.5">
      <div className="flex items-center gap-2">
        <strong className="flex-1">Start at login</strong>
        <span title={look.tip} className={`rounded-full px-2 py-0.5 font-mono text-xs ${look.className}`}>
          {look.glyph}
        </span>
      </div>
      <span className="text-neutral-700">
        {systemd
          ? 'Runs in the background as a systemd user service.'
          : 'Runs in the background. macOS lists it under App Background Activity.'}
      </span>
      {!state.dev_build && !state.on && (
        <span className="text-neutral-700">
          {systemd ? (
            <>
              Run <code>ops-console start</code> to enable it.
            </>
          ) : (
            <>
              Switch Ops Console on under App Background Activity in Login Items, then run{' '}
              <code>ops-console start</code>.
            </>
          )}
        </span>
      )}
      {systemd && !state.dev_build && state.lingering === false && (
        <span className="text-neutral-700">
          It stops when you log out. To keep it running, run <code>{LINGER_COMMAND}</code> once.
        </span>
      )}
      {!state.dev_build && !systemd && (
        <div className="flex gap-2">
          <Button
            variant={state.on ? 'secondary' : 'primary'}
            className="px-3 py-1.25 text-xs"
            title="Opens System Settings at Login Items & Extensions"
            onClick={() => openSettings.mutate()}
          >
            Open Login Items
          </Button>
          {!state.on && (
            <Button
              className="px-3 py-1.25 text-xs"
              title="Read it again after you change it in System Settings"
              disabled={login.isFetching}
              onClick={() => login.refetch()}
            >
              Check again
            </Button>
          )}
        </div>
      )}
      {openSettings.error && (
        <div role="alert" className="text-accent-700">
          {openSettings.error.message}
        </div>
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
