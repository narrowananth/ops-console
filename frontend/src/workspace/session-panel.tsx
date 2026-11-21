import {
  type LocalServer,
  PrChecks,
  type PrState,
  type Session,
  type SessionDiff,
  type Subagent,
  SubagentStatus,
} from '@ops-console/shared';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { Spinner } from '../components/ui/button';
import { Elapsed } from '../components/ui/elapsed';
import {
  AgentIcon,
  CheckCircleIcon,
  ChevronIcon,
  CloseIcon,
  CommitIcon,
  CrossCircleIcon,
  DiffIcon,
  DotCircleIcon,
  FolderIcon,
  GlobeIcon,
  PullRequestIcon,
  PushIcon,
  TerminalIcon,
  TrashIcon,
  VsCodeIcon,
} from '../components/ui/icons';
import { sessionPath } from './links';

const STATUS_DOT: Record<SubagentStatus, string> = {
  [SubagentStatus.Working]: 'bg-accent',
  [SubagentStatus.Done]: 'bg-ok',
  [SubagentStatus.Failed]: 'bg-diff-del-text',
  [SubagentStatus.Stopped]: 'bg-neutral-500',
};

/** The subagents a run waits on: the ones still working, newest last. */
export const workingSubagents = (subagents: Subagent[]): Subagent[] =>
  subagents.filter((one) => one.status === SubagentStatus.Working);

/**
 * Above the composer while the main agent waits on its subagents: how many, their names on hover, and a Stop that ends
 * the run and with it every subagent it started.
 */
export function SubagentWait({
  subagents,
  stopping,
  onStop,
}: {
  subagents: Subagent[];
  stopping: boolean;
  onStop: () => void;
}) {
  const working = workingSubagents(subagents);
  if (working.length === 0) return null;
  const label = `Waiting on ${working.length} ${working.length === 1 ? 'subagent' : 'subagents'}`;
  return (
    <div className="group relative flex w-full items-center gap-3 px-6 py-2 text-sm text-neutral-700">
      <Spinner />
      <span className="flex-none text-text">{label}</span>
      <span className="min-w-0 flex-1 truncate text-neutral-600">
        {working.map((one) => one.description).join(', ')}
      </span>
      <span
        aria-hidden
        className="flex size-7 flex-none items-center justify-center rounded-full border border-line text-xs text-neutral-700"
      >
        i
      </span>
      <button
        type="button"
        disabled={stopping}
        onClick={onStop}
        title="Stop the agent and its subagents"
        className="flex-none cursor-pointer border-0 bg-transparent px-1 text-sm font-semibold text-text hover:text-accent-700 disabled:cursor-default disabled:opacity-50"
      >
        Stop
      </button>
      <div
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-6 z-20 mb-1.5 hidden w-[min(40rem,calc(100%-3rem))] rounded-xl border border-divider bg-card p-3 text-sm shadow-lg group-focus-within:block group-hover:block"
      >
        <b>{label}</b>
        <ul className="m-0 mt-1.5 list-none space-y-1 p-0">
          {working.map((one) => (
            <li key={one.id} className="flex items-center gap-2">
              <span aria-hidden className={`size-2 flex-none rounded-full ${STATUS_DOT[one.status]}`} />
              <span className="min-w-0 flex-1 truncate">{one.description}</span>
              <Elapsed
                from={one.started_at}
                to={null}
                running
                className="flex-none font-mono text-xs text-neutral-600"
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export type Surface = 'browser' | 'terminal' | 'diff';

type RowProps = {
  children: ReactNode;
  onClick?: () => void;
  to?: string;
  href?: string;
  title?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** The accessible name, when the text alone would repeat another control's. */
  label?: string;
  /** Set on a row that opens or folds more rows: whether they are shown now. */
  expanded?: boolean;
};

function Row({
  children,
  onClick,
  to,
  href,
  title,
  icon,
  label,
  expanded,
  danger = false,
  disabled = false,
}: RowProps) {
  const cls = `flex w-full items-center gap-3 rounded-lg border-0 bg-transparent px-3 py-2 text-left text-sm no-underline enabled:cursor-pointer enabled:hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-50 ${danger ? 'text-accent-700' : 'text-text'}`;
  const inner = (
    <>
      {icon && <span className="flex w-4 flex-none justify-center text-neutral-700">{icon}</span>}
      {children}
    </>
  );
  if (to)
    return (
      <Link to={to} title={title} aria-label={label} className={cls}>
        {inner}
      </Link>
    );
  if (href)
    return (
      <a href={href} target="_blank" rel="noreferrer" title={title} aria-label={label} className={cls}>
        {inner}
      </a>
    );
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      aria-expanded={expanded}
      onClick={onClick}
      disabled={disabled}
      className={cls}
    >
      {inner}
    </button>
  );
}

const Section = ({ label, children }: { label?: string; children: ReactNode }) => (
  <div className="border-t border-line px-2 py-2 first:border-t-0">
    {label && <div className="px-3 pt-1 pb-1.5 text-xs text-neutral-600">{label}</div>}
    {children}
  </div>
);

const CHECKS: Record<PrChecks, { word: string; tip: string } | null> = {
  [PrChecks.None]: null,
  [PrChecks.Running]: { word: 'running', tip: 'CI checks are still running on the newest commit' },
  [PrChecks.Passed]: { word: 'passed', tip: 'Every CI check passed on the newest commit' },
  [PrChecks.Failed]: { word: 'failed', tip: 'At least one CI check failed on the newest commit' },
};

/** The pull request's CI state as a small ring: green tick, red cross, or an amber dot while it runs. */
function ChecksMark({ checks }: { checks: PrChecks }) {
  const shown = CHECKS[checks];
  if (shown === null) return null;
  return (
    <span title={shown.tip} className="flex items-center gap-1 text-neutral-700">
      {checks === PrChecks.Passed ? (
        <CheckCircleIcon tone="text-ok" />
      ) : checks === PrChecks.Failed ? (
        <CrossCircleIcon tone="text-diff-del-text" />
      ) : (
        <DotCircleIcon tone="text-warn" />
      )}
      checks {shown.word}
    </span>
  );
}

/** A pull request of the Session. `info` is what the Git host's list says of it; null while that list is unread or lacks it. */
export type PullRequestRow = {
  number: number;
  href: string;
  to: string | null;
  info: { title: string; checks: PrChecks; state: PrState } | null;
};

/** Rows shown before "Show N more". */
const PULL_REQUESTS_SHOWN = 3;

function PullRequestItem({ row }: { row: PullRequestRow }) {
  const { number, to, href, info } = row;
  return (
    <div className="flex flex-col gap-1 px-3 py-2 text-sm">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex w-4 flex-none justify-center text-accent-2-600">
          <PullRequestIcon />
        </span>
        <span className="min-w-0 flex-1 leading-snug break-words">{info?.title ?? `Pull request #${number}`}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-7 text-xs">
        {to && (
          <Link
            to={to}
            title={`Open pull request #${number} in the Workspace's Pull requests tab`}
            className="text-neutral-700 no-underline hover:underline"
          >
            PR #{number} →
          </Link>
        )}
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title={`Open pull request #${number} on the Git host`}
          className="text-neutral-700 no-underline hover:underline"
        >
          #{number} on host ↗
        </a>
        {info && <span className="text-neutral-700">{info.state}</span>}
        {info && <ChecksMark checks={info.checks} />}
      </div>
    </div>
  );
}

/** The pull requests of the Session, the first few with the rest behind "Show N more". */
function PullRequestList({ rows }: { rows: PullRequestRow[] }) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;
  const hidden = rows.length - PULL_REQUESTS_SHOWN;
  const shown = all || hidden <= 0 ? rows : rows.slice(0, PULL_REQUESTS_SHOWN);
  return (
    <>
      {shown.map((row) => (
        <PullRequestItem key={row.number} row={row} />
      ))}
      {hidden > 0 && (
        <Row icon={<ChevronIcon open={all} />} expanded={all} onClick={() => setAll((now) => !now)}>
          {all ? 'Show less' : `Show ${hidden} more`}
        </Row>
      )}
    </>
  );
}

/** What the Commit, push & PR split button does. */
export type Publish = {
  /** Files with changes not committed yet. */
  uncommitted: number;
  /** The branch is the default one, or the Session is running: nothing to commit, push or open from here. */
  blocked: string | null;
  canOpenPullRequest: boolean;
  onCommit: () => void;
  onPush: () => void;
  onOpenPullRequest: () => void;
  pushing: boolean;
  error: string | null;
};

/**
 * T3's split button: the row does the next step (Commit while files are uncommitted, then Create PR when the branch can
 * open one, else Push), and its chevron lists the three.
 */
function PublishRow({ publish }: { publish: Publish }) {
  const [open, setOpen] = useState(false);
  const { uncommitted, blocked, canOpenPullRequest } = publish;
  const next =
    uncommitted > 0
      ? { label: 'Commit', run: publish.onCommit }
      : canOpenPullRequest
        ? { label: 'Create PR', run: publish.onOpenPullRequest }
        : { label: 'Push', run: publish.onPush };
  const act = (run: () => void) => {
    setOpen(false);
    run();
  };
  const item =
    'flex w-full items-center gap-3 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-sm text-text enabled:cursor-pointer enabled:hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-45';
  return (
    <div className="relative">
      {open && (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          className="fixed inset-0 z-40 cursor-default"
          onClick={() => setOpen(false)}
        />
      )}
      <div className="flex items-center rounded-lg hover:bg-neutral-200/60">
        <button
          type="button"
          title={blocked ?? `${next.label}: the next step for this branch`}
          disabled={blocked !== null || publish.pushing}
          onClick={next.run}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg border-0 bg-transparent px-3 py-2 text-left text-sm text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="flex w-4 flex-none justify-center text-neutral-700">
            {publish.pushing ? <Spinner /> : <PushIcon />}
          </span>
          <span className="flex-1 truncate">Commit, push &amp; PR</span>
        </button>
        <button
          type="button"
          aria-label="Commit, push and PR options"
          aria-expanded={open}
          title="Commit, Push or Create PR"
          disabled={blocked !== null}
          onClick={() => setOpen((now) => !now)}
          className="mr-1 flex size-7 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-neutral-700 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ChevronIcon open={open} />
        </button>
      </div>
      {open && (
        <div
          role="menu"
          className="absolute right-1 left-1 z-50 mt-1 rounded-lg border border-line bg-card p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            disabled={uncommitted === 0}
            onClick={() => act(publish.onCommit)}
            className={item}
          >
            <CommitIcon />
            <span className="flex-1">Commit</span>
            {uncommitted > 0 && <span className="font-mono text-xs text-neutral-600">{uncommitted}</span>}
          </button>
          <button type="button" role="menuitem" onClick={() => act(publish.onPush)} className={item}>
            <PushIcon />
            Push
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canOpenPullRequest}
            onClick={() => act(publish.onOpenPullRequest)}
            className={item}
          >
            <PullRequestIcon />
            Create PR
          </button>
        </div>
      )}
      {publish.error && (
        <p role="alert" className="m-0 px-3 pb-1 text-xs text-accent-700">
          {publish.error}
        </p>
      )}
    </div>
  );
}

/**
 * The Session's context in one card, as the thread panel of T3 Code: the surfaces to open beside the conversation, the
 * branch and its pull request, the changes, the servers its processes started, the lineage (the Session that started
 * it, the Sessions it started, and the subagents of its latest run), and the actions on the Session itself.
 */
export function SessionPanel({
  session,
  branch,
  pullRequests,
  publish,
  branchControl,
  folder,
  diff,
  servers,
  hasBrowser,
  hasDiff,
  browserPort,
  terminalsRunning,
  terminalsOpen,
  links,
  remove,
  onOpen,
  onOpenServer,
  onClose,
}: {
  session: Session;
  branch: string | null;
  /** The pull requests to list, newest first. */
  pullRequests: PullRequestRow[];
  /** Commit, Push and Create PR; null when the Session has no branch of its own. */
  publish: Publish | null;
  /** The branch picker, drawn where the branch name goes. */
  branchControl: ReactNode;
  /** Opens the Session's worktree in the editor or the file manager of this machine. */
  folder: { disabled: boolean; onEditor: () => void; onFolder: () => void; error: string | null } | null;
  diff: SessionDiff | undefined;
  servers: LocalServer[];
  hasBrowser: boolean;
  hasDiff: boolean;
  /** A server of this Session is listening on this port and no browser tab shows it. */
  browserPort: number | null;
  /** Processes of this Session that are running. */
  terminalsRunning: number;
  terminalsOpen: boolean;
  /** Rows for the Alert and the Playbook this Session belongs to. */
  links: ReactNode;
  remove: { disabled: boolean; title: string; error: string | null; onDelete: () => void };
  onOpen: (surface: Surface) => void;
  onOpenServer: (port: number) => void;
  onClose: () => void;
}) {
  const own = servers.filter((server) => server.session_id === session.id);
  const changed = diff && diff.files.length > 0 ? diff : null;
  const ordered = [...session.subagents].sort(
    (a, b) => Number(b.status === SubagentStatus.Working) - Number(a.status === SubagentStatus.Working),
  );
  const lineage = session.spawned_by !== null || session.spawned.length > 0 || ordered.length > 0;
  return (
    <aside aria-label="Session" className="flex min-h-0 w-full flex-col overflow-y-auto bg-bg p-3">
      <div className="rounded-2xl border border-line bg-card shadow-md">
        <div className="flex items-center justify-between px-5 pt-3 pb-1">
          <h3 className="m-0 text-sm font-semibold">Session</h3>
          <button
            type="button"
            aria-label="Close the Session panel"
            title="Close this panel"
            onClick={onClose}
            className="flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-neutral-700 hover:bg-neutral-200 hover:text-text"
          >
            <CloseIcon />
          </button>
        </div>
        {folder && (
          <Section>
            <div className="flex items-center">
              <div className="min-w-0 flex-1">
                <Row
                  icon={<VsCodeIcon />}
                  disabled={folder.disabled}
                  onClick={folder.onEditor}
                  title="Open this Session's folder in Visual Studio Code"
                >
                  Open in VS Code
                </Row>
              </div>
              <button
                type="button"
                aria-label="Show the folder"
                title="Show this Session's folder in the file manager"
                disabled={folder.disabled}
                onClick={folder.onFolder}
                className="mr-2 flex size-7 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-neutral-700 hover:bg-neutral-200 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FolderIcon />
              </button>
            </div>
            {folder.error && (
              <p role="alert" className="m-0 px-3 pb-1 text-xs text-accent-700">
                {folder.error}
              </p>
            )}
          </Section>
        )}
        <Section label="Open a surface">
          {hasBrowser && (
            <Row
              icon={<GlobeIcon />}
              onClick={() => onOpen('browser')}
              title={
                browserPort === null
                  ? 'Open the Session’s browser beside the conversation'
                  : `A server of this Session is listening on :${browserPort}. Open the browser to see it.`
              }
            >
              <span className="flex-1">Browser</span>
              {browserPort !== null && (
                <span className="rounded-full bg-ok px-1.5 font-mono text-[10px] leading-4 font-semibold text-white">
                  :{browserPort}
                </span>
              )}
            </Row>
          )}
          {hasBrowser && (
            <Row
              icon={<TerminalIcon />}
              onClick={() => onOpen('terminal')}
              title={
                terminalsOpen
                  ? 'Hide the terminals. Their processes keep running.'
                  : 'Run your dev server, a script or a shell for this Session'
              }
            >
              <span className="flex-1">Terminals</span>
              {terminalsRunning > 0 && (
                <span className="flex items-center gap-1 font-mono text-xs font-semibold">
                  <span aria-hidden className="size-1.5 rounded-full bg-ok" />
                  {terminalsRunning}
                </span>
              )}
            </Row>
          )}
          {hasDiff && (
            <Row icon={<DiffIcon />} onClick={() => onOpen('diff')} title="Show what this Session's branch changes">
              Diff
            </Row>
          )}
        </Section>
        {(branch || publish) && (
          <Section>
            {branch && (
              <div className="px-1 py-1" title="The branch this Session works on. Pick another to switch.">
                {branchControl}
              </div>
            )}
            <PullRequestList rows={pullRequests} />
            {publish && <PublishRow publish={publish} />}
            {changed && (
              <Row icon={<DiffIcon />} onClick={() => onOpen('diff')} title="Show what this Session's branch changes">
                <span className="flex-1">Changes</span>
                <span className="font-mono text-xs font-semibold">
                  <span className="text-diff-add-text">+{changed.additions}</span>{' '}
                  <span className="text-diff-del-text">−{changed.deletions}</span>
                </span>
              </Row>
            )}
          </Section>
        )}
        {own.length > 0 && (
          <Section label="Servers">
            {own.map((server) => (
              <Row
                key={server.port}
                icon={<GlobeIcon />}
                onClick={() => onOpenServer(server.port)}
                title="Open this server in the browser"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">localhost:{server.port}</span>
                  <span className="block text-xs text-neutral-600">Agent · {server.process}</span>
                </span>
              </Row>
            ))}
          </Section>
        )}
        {links && <Section>{links}</Section>}
        {lineage && (
          <Section label="Lineage">
            {session.spawned_by && (
              <Row
                icon={<AgentIcon />}
                to={sessionPath(session.spawned_by.id)}
                title="The Session whose agent started this one with a task for this Repo"
              >
                <span className="min-w-0 flex-1 truncate">Started from {session.spawned_by.title} →</span>
              </Row>
            )}
            {session.spawned.map((child) => (
              <Row key={child.id} icon={<AgentIcon />} to={sessionPath(child.id)}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{child.title}</span>
                  <span className="block text-xs text-neutral-600">
                    {child.repo_name ?? 'Session'} · {child.state.replace('_', ' ')}
                  </span>
                </span>
              </Row>
            ))}
            {ordered.length > 0 && (
              <div className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="flex w-4 flex-none justify-center text-neutral-700">
                  <AgentIcon />
                </span>
                <span className="flex-1">Previous agents</span>
                <span className="font-mono text-xs text-neutral-600">{ordered.length}</span>
              </div>
            )}
            {ordered.map((one) => (
              <div key={one.id} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                <span aria-hidden className={`ml-1 size-2 flex-none rounded-full ${STATUS_DOT[one.status]}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate" title={one.description}>
                    {one.description}
                  </span>
                  <span className="block text-xs text-neutral-600">
                    {one.type ?? 'Subagent'} · {one.status}
                  </span>
                </span>
                <Elapsed
                  from={one.started_at}
                  to={one.finished_at}
                  running={one.status === SubagentStatus.Working}
                  className="flex-none font-mono text-xs text-neutral-600"
                />
              </div>
            ))}
          </Section>
        )}
        <Section>
          <Row icon={<TrashIcon />} danger title={remove.title} disabled={remove.disabled} onClick={remove.onDelete}>
            Delete
          </Row>
          {remove.error && (
            <p role="alert" className="m-0 px-3 pb-1 text-xs text-accent-700">
              {remove.error}
            </p>
          )}
        </Section>
      </div>
    </aside>
  );
}
