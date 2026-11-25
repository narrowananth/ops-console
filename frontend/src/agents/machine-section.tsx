import { KEYCHAIN_HANDOVER_MESSAGE, KEYCHAIN_WAIT_MESSAGE } from '@ops-console/shared';
import type { ReactNode } from 'react';
import { Section } from '../app/page';
import { Button } from '../components/ui/button';
import {
  useDiskAccess,
  useKeychainHandover,
  useKeychainWait,
  useOpenDiskAccessSettings,
  useOpenLoginItemsSettings,
  useRunSandbox,
  useStartAtLogin,
} from '../lib/queries';

const PILL = 'rounded-full px-2 py-0.5 font-mono text-xs';

/** One status: its name and pill, what it means, and whatever the operator can do about it. */
function Row({
  name,
  pill,
  children,
}: {
  name: string;
  pill: { glyph: string; className: string; tip: string };
  children?: ReactNode;
}) {
  return (
    <li aria-label={name} className="flex flex-col gap-2 px-5 py-4 text-xs">
      <div className="flex items-center gap-2">
        <strong className="flex-1 text-sm">{name}</strong>
        <span title={pill.tip} className={`${PILL} ${pill.className}`}>
          {pill.glyph}
        </span>
      </div>
      {children}
    </li>
  );
}

/** What macOS lets the console do, and what an agent run's commands can reach: one row each with where it stands. */
export function MachineSection() {
  return (
    <div id="on-this-machine" className="scroll-mt-6">
      <Section title="On this machine" sub="What macOS lets the console do, and what an agent run can reach.">
        <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
          <DiskAccessRow />
          <StartAtLoginRow />
          <RunSandboxRow />
          <KeychainRow />
        </ul>
      </Section>
    </div>
  );
}

/** macOS only: nothing here when the daemon cannot read the state. */
function DiskAccessRow() {
  const access = useDiskAccess();
  const openSettings = useOpenDiskAccessSettings();
  const state = access.data;
  if (!state || state.granted === null) return null;
  const pill = state.granted
    ? {
        glyph: '● on',
        className: 'bg-ok/12 text-ok',
        tip: "An Anonymous Session's agent can read the folders it needs.",
      }
    : state.app_path
      ? {
          glyph: '✕ off',
          className: 'bg-accent-100 text-accent-700',
          tip: "An Anonymous Session's agent cannot read protected folders until you turn this on in System Settings.",
        }
      : {
          glyph: '○ off · dev build',
          className: 'bg-neutral-200 text-neutral-700',
          tip: 'pnpm dev builds no app to grant it to.',
        };
  return (
    <Row name="Full Disk Access" pill={pill}>
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
      {openSettings.error && (
        <div role="alert" className="text-accent-700">
          {openSettings.error.message}
        </div>
      )}
    </Row>
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
  const pill = state.dev_build
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
    <Row name="Start at login" pill={pill}>
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
    </Row>
  );
}

/** Whether agent runs' commands run inside the Run sandbox. Read-only: no Setting turns it off. */
function RunSandboxRow() {
  const sandbox = useRunSandbox();
  const state = sandbox.data;
  const pill = !state
    ? { glyph: '… checking', className: 'bg-neutral-200 text-neutral-700', tip: 'Testing the sandbox.' }
    : state.status === 'on'
      ? {
          glyph: '● on',
          className: 'bg-ok/12 text-ok',
          tip: 'Agent runs cannot read the login Keychain folder or the installed app, or change git hooks and config.',
        }
      : {
          glyph: '✕ unavailable',
          className: 'bg-accent-100 text-accent-700',
          tip: 'Agent runs fail rather than run without the sandbox.',
        };
  return (
    <Row name="Run sandbox" pill={pill}>
      <span className="text-neutral-700">
        Keeps an agent run's commands out of the login Keychain. They write anywhere, reach any host and use localhost,
        as in your terminal.
      </span>
      {state?.status === 'unavailable' && <span className="text-accent-700">{state.reason}</span>}
      {sandbox.error && (
        <span role="alert" className="text-accent-700">
          {sandbox.error.message}
        </span>
      )}
    </Row>
  );
}

/** macOS asks before each saved password; a question left unanswered holds up the runs that need it. */
function KeychainRow() {
  const read = useKeychainWait();
  const handover = useKeychainHandover();
  const refused = handover.data?.refused === true;
  const failure = read.error ?? handover.error;
  const wait = read.data;
  const waiting = wait?.waiting === true;
  const since = wait?.since ? new Date(wait.since).toLocaleTimeString([], { timeStyle: 'short' }) : null;
  const pill = {
    glyph: read.isPending ? '… checking' : waiting ? `◐ waiting since ${since}` : '◐ asks each time',
    className: waiting ? 'bg-accent-100 text-accent-700' : 'bg-neutral-200 text-neutral-700',
    tip: waiting
      ? 'The Mac is asking for the login password. Runs that need a secret fail if it stays unanswered.'
      : 'macOS asks each time the console reads a saved password.',
  };
  return (
    <Row name="Keychain" pill={pill}>
      <span className="text-neutral-700">
        {waiting ? `${KEYCHAIN_WAIT_MESSAGE}. Answer it on the Mac.` : 'macOS asks before each saved password.'}
      </span>
      {refused && (
        <div role="alert" aria-label="Keychain handover" className="flex flex-col gap-0.5 text-accent-700">
          <span>{KEYCHAIN_HANDOVER_MESSAGE}</span>
          <span className="font-mono text-xs">{handover.data?.reason}</span>
        </div>
      )}
      {failure && (
        <span role="alert" className="text-accent-700">
          {failure.message}
        </span>
      )}
    </Row>
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
