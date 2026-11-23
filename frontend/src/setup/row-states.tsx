import { Button } from '../components/ui/button';

/** The pill a Permissions row shows while it reads its state. */
export function Checking() {
  return <span className="rounded-full bg-neutral-200 px-2 py-0.5 font-mono text-xs text-neutral-700">… checking</span>;
}

/** What a Permissions row says when it could not read its state, with a way to read it again. */
export function ReadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <span role="alert" className="text-accent-700">
        {message}
      </span>
      <Button className="px-3 py-1.25 text-xs" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
