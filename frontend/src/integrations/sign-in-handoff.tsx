import type { Connector } from '@ops-console/shared';

/** The one-time code and the link a browser sign-in waits on, while a Connector signs in. */
export function SignInHandoff({ signIn, label }: { signIn: NonNullable<Connector['sign_in']>; label: string }) {
  if (!signIn.code && !signIn.url) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md bg-neutral-200 px-3.5 py-3">
      {signIn.code && (
        <div className="flex flex-col">
          <span className="text-xs text-neutral-700">Enter this code (already copied)</span>
          <span className="font-mono text-lg font-semibold tracking-widest">{signIn.code}</span>
        </div>
      )}
      {signIn.url && (
        <a
          href={signIn.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 font-heading text-sm font-semibold text-white no-underline shadow-sm hover:bg-accent-600 hover:text-white"
        >
          Open {label} ↗
        </a>
      )}
    </div>
  );
}
