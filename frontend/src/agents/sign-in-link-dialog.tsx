import { type ClaudeAccount, SignInVia } from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { BrandIcon } from '../components/ui/brand-icon';
import { Button, Spinner } from '../components/ui/button';
import { useCancelLogin, useStartLogin, useSubmitSignInCode } from '../lib/queries';

function left(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** `claude.com/cai/oauth/…` with the host in bold, the rest cut to fit. */
function LinkText({ url }: { url: string }) {
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (!parsed) return <span className="min-w-0 flex-1 truncate">{url}</span>;
  return (
    <span className="min-w-0 flex-1 truncate">
      <strong className="text-text">{parsed.host}</strong>
      <span className="text-neutral-700">{url.slice(parsed.origin.length)}</span>
    </span>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[26px_minmax(0,1fr)] gap-3">
      <span className="flex size-6.5 items-center justify-center rounded-full bg-neutral-200 font-mono text-xs font-semibold">
        {number}
      </span>
      <div className="flex min-w-0 flex-col gap-2 pt-1">
        <div className="text-[13px] font-semibold">{title}</div>
        {children}
      </div>
    </div>
  );
}

/**
 * A Claude account's sign-in by link: the link to open in any browser, on this Mac or someone else's computer, and a
 * box for the code Anthropic shows after the sign-in. Closing it keeps the sign-in waiting; the row's Show link opens
 * it again. Escape, Close and a click on the dimmed page close it.
 */
export function SignInLinkDialog({ account, onClose }: { account: ClaudeAccount | undefined; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const submit = useSubmitSignInCode();
  const restart = useStartLogin();
  const cancel = useCancelLogin();

  useEffect(() => {
    const box = dialog.current;
    if (!box || box.open) return;
    box.showModal();
    return () => box.close();
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const link = account?.sign_in_link ?? null;
  const url = link?.url ?? null;
  // A turned-down code gives a new link: the old one, and the code typed for it, no longer count.
  const shownUrl = useRef(url);
  useEffect(() => {
    if (url === shownUrl.current) return;
    shownUrl.current = url;
    setCopied(false);
  }, [url]);

  const send = () => {
    if (!account || code.trim() === '') return;
    submit.mutate({ id: account.id, code }, { onSuccess: () => setCode(''), onError: () => setCode('') });
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a modal dialog natively; the click is the backdrop
    <dialog
      ref={dialog}
      aria-labelledby="sign-in-link-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto w-[min(560px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-line bg-card p-0 text-text shadow-2xl backdrop:bg-neutral-900/35"
    >
      <div className="flex items-center gap-3 px-5 pt-5 pb-1">
        <BrandIcon brand="claude" />
        <div className="min-w-0 flex-1">
          <h2 id="sign-in-link-title" className="m-0 font-heading text-base">
            Sign in by link
          </h2>
          {account && <div className="truncate font-mono text-xs text-neutral-700">{account.label}</div>}
        </div>
        <Button icon className="size-8 rounded-full" aria-label="Close" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </Button>
      </div>

      {!account ? (
        <p className="m-0 px-5 pt-3 pb-5 text-[13px] text-neutral-700">
          This sign-in ended and the new account was removed. Add by sign-in link again for a new link.
        </p>
      ) : account.signed_in && !account.signing_in ? (
        <p role="status" className="m-0 px-5 pt-3 pb-5 text-[13px]">
          Signed in as <strong className="font-mono">{account.email ?? account.label}</strong>. The account is in the
          list now.
        </p>
      ) : !link ? (
        <div className="flex flex-col gap-3 px-5 pt-3 pb-5 text-[13px] text-neutral-700">
          <p className="m-0">The sign-in stopped: it was cancelled or the link ran out of time.</p>
          <div>
            <Button
              variant="primary"
              className="px-3 py-1.5 text-xs"
              disabled={restart.isPending}
              onClick={() => restart.mutate({ id: account.id, via: SignInVia.Link })}
            >
              New link
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 px-5 pt-3 pb-5">
          <p className="m-0 text-[13px] leading-relaxed text-neutral-700">
            Open the link in any browser, or send it to whoever owns the Claude account. After the sign-in, Anthropic
            shows a code: paste it in step 2. The agent then runs on that account's Claude subscription.
          </p>
          <Step number={1} title="Open the sign-in link">
            {url ? (
              <>
                <div className="flex items-center gap-2 rounded-lg border border-line bg-bg py-1.5 pr-1.5 pl-3 font-mono text-xs">
                  <LinkText url={url} />
                  <Button
                    className="flex-none px-2.5 py-1 text-xs"
                    onClick={() => {
                      void navigator.clipboard.writeText(url).then(() => setCopied(true));
                    }}
                  >
                    {copied ? 'Copied' : 'Copy link'}
                  </Button>
                </div>
                <div>
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-text px-3 py-1.5 text-xs font-semibold text-card no-underline hover:opacity-90"
                  >
                    Open link
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden
                    >
                      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
                    </svg>
                  </a>
                </div>
                <div className="text-xs text-neutral-700">The link works for one sign-in.</div>
              </>
            ) : (
              <div className="flex items-center gap-2 text-xs text-neutral-700">
                <Spinner /> Getting the link from Claude Code…
              </div>
            )}
          </Step>
          <Step number={2} title="Paste the code Anthropic shows">
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <input
                aria-label="Code from Anthropic"
                placeholder="The code, or the address of the page that shows it"
                autoComplete="off"
                spellCheck={false}
                value={code}
                disabled={!url || submit.isPending}
                onChange={(event) => setCode(event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-divider bg-card px-3 py-1.5 font-mono text-xs text-text"
              />
              <Button
                type="submit"
                variant="primary"
                className="flex-none px-3 py-1.5 text-xs"
                disabled={!url || submit.isPending || code.trim() === ''}
              >
                {submit.isPending && <Spinner />}
                Sign in with code
              </Button>
            </form>
            {submit.error && (
              <div role="alert" className="text-xs text-accent-700">
                {submit.error.message}
              </div>
            )}
          </Step>
        </div>
      )}

      {account?.signing_in && link && (
        <div className="flex items-center gap-2 border-t border-line bg-surface/40 px-5 py-3 text-xs text-neutral-700">
          <span className="size-1.75 flex-none animate-pulse rounded-full bg-accent" aria-hidden />
          <span>Waiting for the sign-in · the link stops working in {left(link.expires_at, now)}</span>
          <span className="flex-1" />
          <Button
            className="px-2.5 py-1 text-xs"
            title="Stop this sign-in. A new account that never signed in is removed."
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(account.id, { onSuccess: onClose })}
          >
            Cancel sign-in
          </Button>
        </div>
      )}
    </dialog>
  );
}
