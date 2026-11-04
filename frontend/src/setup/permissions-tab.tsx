import { KEYCHAIN_WAIT_MESSAGE } from '@ops-console/shared';
import type { ReactNode } from 'react';
import { Logo } from '../app/sidebar';
import { Button } from '../components/ui/button';
import {
  useDiskAccess,
  useKeychainWait,
  useOpenDiskAccessSettings,
  useOpenLoginItemsSettings,
  useRunSandbox,
  useStartAtLogin,
} from '../lib/queries';
import { NetworkAllowlistRow } from './network-allowlist-row';

/** What macOS lets the console do, and what an agent run's commands can reach: one row each with where it stands. */
export function PermissionsTab() {
  return (
    <div className="flex min-h-0 flex-1 overflow-auto">
      <section aria-label="Permissions" className="mx-auto flex w-full max-w-180 flex-col gap-5 px-8 py-7">
        <MacCard />
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
            <NetworkAllowlistRow />
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

/** Full Disk Access, Start at login and Keychain. macOS only: nothing here when the daemon cannot read the state. */
function MacCard() {
  const access = useDiskAccess();
  const openSettings = useOpenDiskAccessSettings();
  const state = access.data;
  if (!state || state.granted === null) return null;
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
          <strong>On this Mac</strong>
        </>
      }
    >
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
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
  const state = sandbox.data;
  const on = state?.status === 'on';
  const look = !state
    ? { glyph: '… checking', className: 'bg-neutral-200 text-neutral-700', tip: 'Testing the sandbox.' }
    : on
      ? {
          glyph: '● on',
          className: 'bg-ok/12 text-ok',
          tip: 'Agent runs write only in their working folder and read nothing of the console or your cloud credentials.',
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
      <span className="text-neutral-700">Limits what an agent run's commands can write and read.</span>
      {state?.status === 'unavailable' && <span className="text-accent-700">{state.reason}</span>}
      {sandbox.error && (
        <span role="alert" className="text-accent-700">
          {sandbox.error.message}
        </span>
      )}
    </li>
  );
}

/** macOS asks before each saved password; a question left unanswered holds up the runs that need it. */
function KeychainRow() {
  const read = useKeychainWait();
  const wait = read.data;
  const waiting = wait?.waiting === true;
  const since = wait?.since ? new Date(wait.since).toLocaleTimeString([], { timeStyle: 'short' }) : null;
  return (
    <li aria-label="Keychain" className="flex flex-col gap-2 rounded-lg bg-bg px-3 py-2.5">
      <div className="flex items-center gap-2">
        <strong className="flex-1">Keychain</strong>
        <span
          title={
            waiting
              ? 'The Mac is asking for the login password. Runs that need a secret fail if it stays unanswered.'
              : 'macOS asks each time the console reads a saved password.'
          }
          className={`rounded-full px-2 py-0.5 font-mono text-xs ${waiting ? 'bg-accent-100 text-accent-700' : 'bg-neutral-200 text-neutral-700'}`}
        >
          {read.isPending ? '… checking' : waiting ? `◐ waiting since ${since}` : '◐ asks each time'}
        </span>
      </div>
      <span className="text-neutral-700">
        {waiting ? `${KEYCHAIN_WAIT_MESSAGE}. Answer it on the Mac.` : 'macOS asks before each saved password.'}
      </span>
      {read.error && (
        <span role="alert" className="text-accent-700">
          {read.error.message}
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
      <span className="text-neutral-700">Runs in the background. macOS lists it under App Background Activity.</span>
      {!state.dev_build && !state.on && (
        <span className="text-neutral-700">
          Switch Ops Console on under App Background Activity in Login Items, then run <code>ops-console start</code>.
        </span>
      )}
      {!state.dev_build && (
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
