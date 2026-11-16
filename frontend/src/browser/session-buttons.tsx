import { Button } from '../components/ui/button';

/** The Session header's Browser button; a green port badge says a server of the Session is listening and no tab is open. */
export function BrowserToggle({ open, port, onToggle }: { open: boolean; port: number | null; onToggle: () => void }) {
  return (
    <span className="relative flex">
      <Button
        aria-pressed={open}
        title={
          open
            ? 'Close the browser. Its tabs stay open.'
            : port === null
              ? 'Open the Session’s browser beside the conversation'
              : `A server of this Session is listening on :${port}. Open the browser to see it.`
        }
        className={`px-2.5 py-1 text-xs ${open ? 'border-accent-300 bg-accent-100' : ''}`}
        onClick={onToggle}
      >
        Browser
      </Button>
      {!open && port !== null && (
        <span
          aria-hidden
          className="pointer-events-none absolute -top-2 right-1 rounded-full bg-ok px-1.5 font-mono text-[10px] leading-4 font-semibold text-white"
        >
          :{port}
        </span>
      )}
    </span>
  );
}

/** The Session header's Terminals button; the dot says a process of the Session is running. */
export function TerminalsToggle({ open, running, onToggle }: { open: boolean; running: number; onToggle: () => void }) {
  return (
    <Button
      aria-pressed={open}
      title={
        open ? 'Close the terminals. Their processes keep running.' : 'Run scripts and open terminals for this Session'
      }
      className={`px-2.5 py-1 text-xs ${open ? 'border-accent-300 bg-accent-100' : ''}`}
      onClick={onToggle}
    >
      Terminals
      {running > 0 && (
        <span className="flex items-center gap-1 font-mono font-semibold">
          <span aria-hidden className="size-1.5 rounded-full bg-ok" />
          {running}
        </span>
      )}
    </Button>
  );
}
