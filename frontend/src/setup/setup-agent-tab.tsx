import type { ReactNode } from 'react';
import { Logo } from '../app/sidebar';
import { Button } from '../components/ui/button';
import {
  useCloseSetupTerminal,
  useDiskAccess,
  useOpenDiskAccessSettings,
  useOpenLoginItemsSettings,
  useSetupTerminal,
  useStartAtLogin,
  useStartSetupTerminal,
} from '../lib/queries';
import { EXAMPLES, queueSetupLine, SetupTerminal } from './setup-terminal';

/** Setup agent: Claude, in a terminal, setting up what the other pages hold from the operator's words. */
export function SetupAgentTab() {
  const start = useStartSetupTerminal();
  const close = useCloseSetupTerminal();
  const terminal = useSetupTerminal().data ?? null;
  const access = useDiskAccess().data;
  // Ops Console starts only with Full Disk Access on. Under `OPS_CONSOLE_DEV_INLINE=1 pnpm dev`, or off macOS, the
  // daemon is no app of its own and there is no entry to switch on.
  const locked = access?.granted === false && access.app_path !== null;
  const begin = (line?: string) => {
    if (line) queueSetupLine(line);
    start.mutate();
  };
  return (
    <div className="flex min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex w-full max-w-300 gap-6 px-8 py-7">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {terminal ? (
            <SetupTerminal terminalId={terminal} onClose={() => close.mutate(terminal)} />
          ) : (
            <Welcome locked={locked} pending={start.isPending} onStart={begin} />
          )}
          {start.error && (
            <div role="alert" className="rounded-md bg-accent-100 px-3.5 py-2.5 text-xs text-accent-700">
              {start.error.message}
            </div>
          )}
        </div>
        <aside className="flex w-80 flex-none flex-col gap-4 self-start">
          <Permissions locked={locked && !terminal} />
          <Card title="What it sets up">
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-xs text-neutral-700">
              <Fact icon="db">Connections to your local databases</Fact>
              <Fact icon="plug">MCP servers from your Claude config</Fact>
              <Fact icon="key">Connectors, through each service's own sign-in</Fact>
              <Fact icon="lock">Passwords go in a masked field</Fact>
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/** Before the terminal starts: what to ask, and the button that starts it. */
const LOCKED_TIP = 'Turn on Full Disk Access under Permissions first.';

function Welcome(props: { locked: boolean; pending: boolean; onStart: (line?: string) => void }) {
  return (
    <section className="flex flex-col gap-6 rounded-xl border border-line bg-card px-8 py-8 shadow-sm">
      <div className="flex items-start gap-4">
        <span className="flex size-12 flex-none items-center justify-center rounded-lg bg-accent-100 text-accent">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M4 17l6-5-6-5M12 19h8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-xl">Tell Claude what to set up</h2>
          <p className="mt-1.5 mb-0 max-w-xl text-[13px] text-neutral-700">
            Claude runs in a terminal on this Mac. Ask in plain words and it adds Connections, MCP servers and
            Connectors for you.
          </p>
        </div>
        <Button
          variant="primary"
          title={
            props.locked
              ? LOCKED_TIP
              : 'Opens Claude in a terminal here. It only adds Connections, MCP Servers and Connectors; it removes nothing.'
          }
          disabled={props.pending || props.locked}
          onClick={() => props.onStart()}
        >
          Start setup agent
        </Button>
      </div>
      <div>
        <div className="mb-2.5 text-[11px] font-semibold tracking-[0.06em] text-neutral-600 uppercase">Try asking</div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              title={props.locked ? LOCKED_TIP : 'Start the Setup agent with this request'}
              disabled={props.pending || props.locked}
              onClick={() => props.onStart(example)}
              className="group flex cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-bg px-4 py-3.5 text-left text-[13px] text-text transition-colors hover:border-accent-300 hover:bg-accent-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="min-w-0 flex-1">{example}</span>
              <span aria-hidden className="text-neutral-500 transition-colors group-hover:text-accent">
                →
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function Card({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-card px-4.5 py-4 shadow-sm">
      <div className="flex items-center gap-2 text-[13px] font-extrabold">
        {title}
        {aside}
      </div>
      {children}
    </section>
  );
}

const FACT_ICONS = {
  db: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  plug: <path d="M9 7V3M15 7V3M7 7h10v5a5 5 0 0 1-10 0zM12 17v4" />,
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M17 6l3 3" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
};

function Fact({ icon, children }: { icon: keyof typeof FACT_ICONS; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2.5">
      <span className="flex size-7 flex-none items-center justify-center rounded-md bg-neutral-200 text-neutral-800">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          {FACT_ICONS[icon]}
        </svg>
      </span>
      {children}
    </li>
  );
}

/** What macOS asks before the Setup agent reads this machine, one row each with where it stands. macOS only. */
function Permissions({ locked }: { locked: boolean }) {
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
    <section
      aria-label="Permissions"
      className="flex flex-col gap-3 rounded-xl border border-line bg-card px-4.5 py-4 text-xs shadow-sm"
    >
      <div className="flex items-center gap-2 text-[13px]">
        <Logo size={20} />
        <strong>Permissions</strong>
      </div>
      {locked && (
        <div className="rounded-md bg-accent-100 px-3 py-2 text-accent-900">
          Turn these on to start the Setup agent.
        </div>
      )}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        <li aria-label="Full Disk Access" className="flex flex-col gap-2 rounded-lg bg-bg px-3 py-2.5">
          <div className="flex items-center gap-2">
            <strong className="flex-1">Full Disk Access</strong>
            <span title={disk.tip} className={`rounded-full px-2 py-0.5 font-mono text-[11px] ${disk.className}`}>
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
        <li aria-label="Keychain" className="flex flex-col gap-2 rounded-lg bg-bg px-3 py-2.5">
          <div className="flex items-center gap-2">
            <strong className="flex-1">Keychain</strong>
            <span className="rounded-full bg-neutral-200 px-2 py-0.5 font-mono text-[11px] text-neutral-700">
              ◐ asks each time
            </span>
          </div>
          <span className="text-neutral-700">macOS asks before each saved password.</span>
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
        <span title={look.tip} className={`rounded-full px-2 py-0.5 font-mono text-[11px] ${look.className}`}>
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
