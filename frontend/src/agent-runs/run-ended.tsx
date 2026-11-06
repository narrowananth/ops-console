import { type AgentRun, type Failure, FailureKind } from '@ops-console/shared';
import { Spinner } from '../components/ui/button';
import { duration } from '../components/ui/elapsed';
import { copyLabel, useCopy } from '../lib/clipboard';
import { useActivateAccount, useAddNetworkDomain, useAgentAccounts, useRunControls } from '../lib/queries';
import { Pill, PillLink } from './run-controls';
import { clock, FAILURE_LABEL, failureTone } from './run-look';
import { Heading } from './run-parts';

/** One line of a failure: a small icon, what it is, and the words. */
function FailureRow({ icon, label, tone, text }: { icon: string; label: string; tone: string; text: string }) {
  return (
    <div className="mb-2.5 grid grid-cols-[1.25rem_1fr] gap-x-2.5">
      <span
        aria-hidden
        className={`mt-px flex size-5 items-center justify-center rounded-full border text-[10px] font-bold ${tone}`}
      >
        {icon}
      </span>
      <div>
        <div className={`font-mono text-[10px] font-bold tracking-wider uppercase ${tone.split(' ').at(-1)}`}>
          {label}
        </div>
        <div className="text-[12.5px]">{text}</div>
      </div>
    </div>
  );
}

/** `Resets at 2:00 PM (in 2h 38m)`; `Reset at …` once it has passed. */
export function resetText(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  return at > now ? `Resets at ${clock(at)} (in ${duration(at - now)})` : `Reset at ${clock(at)}`;
}

/** Why the run ended: what happened, the likely cause, what to do, the raw error, and the buttons that act on it. */
export function FailureBox({ failure, run }: { failure: Failure; run: AgentRun }) {
  const controls = useRunControls(run.session.id);
  const allow = useAddNetworkDomain();
  const activate = useActivateAccount();
  const accounts = useAgentAccounts().data?.data ?? [];
  const [copied, copy] = useCopy();
  const tone = failureTone(failure);
  const label = tone.label;
  const iconTone = `border-current ${label}`;
  const limited = failure.kind === FailureKind.RateLimited;
  const needsAccount = limited || failure.kind === FailureKind.SignedOut;
  const own = accounts.find((one) => one.id === run.session.account_id) ?? accounts.find((one) => one.is_active);
  const name = own ? (own.email ?? own.label) : null;
  const resetsAt = failure.resets_at ?? run.limit?.resets_at ?? null;
  const waitsForReset = limited && resetsAt !== null && Date.parse(resetsAt) > Date.now();
  // The other signed-in account with the most room in its 5-hour window.
  const other = accounts
    .filter((one) => one.signed_in && one.id !== own?.id)
    .sort((a, b) => (a.five_hour_pct ?? 0) - (b.five_hour_pct ?? 0))[0];
  const likely = limited && name ? failure.likely_cause.replace(/^The (Claude )?account/, name) : failure.likely_cause;
  const error = [controls.resume, allow, activate].find((one) => one.isError)?.error;
  return (
    <section className={`mb-5 rounded-xl border p-4 ${tone.box}`}>
      <Heading note={FAILURE_LABEL[failure.kind]}>
        <span className={label}>Why this run ended</span>
      </Heading>
      <FailureRow icon="?" label="What happened" tone={iconTone} text={failure.what_happened} />
      <FailureRow icon="!" label="Likely cause" tone={iconTone} text={likely} />
      <FailureRow icon="✓" label="What to do" tone={iconTone} text={failure.what_to_do} />
      {(resetsAt !== null || failure.resume_point) && (
        <ul className="m-0 mb-1 list-none space-y-0.5 p-0 pl-7.5 text-xs">
          {resetsAt !== null && limited && <li className="font-semibold">{resetText(resetsAt)}</li>}
          {failure.resume_point && (
            <li>
              <b>Resumes at:</b> {failure.resume_point}
            </li>
          )}
        </ul>
      )}
      {failure.raw && (
        <pre className="m-0 mt-3 overflow-x-auto rounded-lg bg-neutral-900 px-3.5 py-2.5 font-mono text-[11px] whitespace-pre-wrap text-neutral-100">
          {failure.raw}
        </pre>
      )}
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        {needsAccount && run.can_retry && (
          <Pill
            dark
            disabled={!other || activate.isPending || controls.resume.isPending}
            title={
              other
                ? `Makes ${other.email ?? other.label} the active account, then runs again`
                : 'No other signed-in account. Add one in Accounts & Usage.'
            }
            onClick={() => other && activate.mutate(other.id, { onSuccess: () => controls.resume.mutate() })}
          >
            {activate.isPending ? <Spinner /> : null}
            Switch account and Retry
          </Pill>
        )}
        {failure.blocked_host && run.can_retry && (
          <Pill
            dark
            disabled={allow.isPending || controls.resume.isPending}
            onClick={() => allow.mutate(failure.blocked_host as string, { onSuccess: () => controls.resume.mutate() })}
          >
            Allow {failure.blocked_host} and Retry
          </Pill>
        )}
        {run.can_retry && (limited || !needsAccount) && (
          <Pill
            dark={!failure.blocked_host && !needsAccount}
            disabled={controls.resume.isPending || waitsForReset}
            title={waitsForReset && resetsAt ? resetText(resetsAt) : undefined}
            onClick={() => controls.resume.mutate()}
          >
            {controls.resume.isPending ? <Spinner /> : null}
            {limited ? 'Retry after reset' : failure.blocked_host ? 'Retry only' : 'Retry'}
          </Pill>
        )}
        {run.can_retry && failure.kind === FailureKind.SignedOut && (
          <Pill disabled={controls.resume.isPending} onClick={() => controls.resume.mutate()}>
            Retry
          </Pill>
        )}
        {needsAccount && <PillLink to="/agents">Open Account &amp; Usage</PillLink>}
        {failure.raw && <Pill onClick={() => copy(failure.raw as string)}>{copyLabel(copied, 'Copy error')}</Pill>}
      </div>
      {error && (
        <p role="alert" className="m-0 mt-2 text-[11px] text-accent-700">
          {error.message}
        </p>
      )}
    </section>
  );
}
