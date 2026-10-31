import {
  refuseSetupLine,
  SETUP_LINE_MAX,
  type TerminalServerMessage,
  terminalServerMessageSchema,
  WS_PROTOCOL,
} from '@ops-console/shared';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui/button';
import { useAnswerSecret } from '../lib/queries';
import { sessionToken } from '../lib/session';

/**
 * The unsent line per terminal, so it survives a tab switch. Memory only: a typed line may hold a password the daemon
 * has not masked yet, so it never reaches browser storage.
 */
const drafts = new Map<string, string>();

const EXAMPLES = ['import my local databases'];

/**
 * The Setup agent's terminal. Keystrokes are not sent as typed: a line goes to the daemon whole, so it can swap
 * passwords for placeholders before Claude sees them. Only plain requests go: the daemon refuses a line that would
 * drive Claude Code itself, such as `/login` or `!cmd`. It runs on while the
 * operator is elsewhere or reloads, and the page attaches to it again; only Close ends it.
 */
export function SetupTerminal({ terminalId, onClose }: { terminalId: string; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const [line, setLineState] = useState(() => drafts.get(terminalId) ?? '');
  const setLine = (text: string) => {
    if (text) drafts.set(terminalId, text);
    else drafts.delete(terminalId);
    setLineState(text);
  };
  const [request, setRequest] = useState<{ request_id: string; label: string } | null>(null);
  const [secret, setSecret] = useState('');
  const [ended, setEnded] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const answer = useAnswerSecret();

  useEffect(() => {
    const token = sessionToken();
    if (!host.current || token === null) return;
    const terminal = new Terminal({ convertEol: true, fontSize: 12, rows: 18, disableStdin: true });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    fit.fit();
    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/terminals/${terminalId}`;
    const ws = new WebSocket(url, [WS_PROTOCOL, token]);
    socket.current = ws;
    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows })),
    );
    ws.addEventListener('message', (event) => {
      const parsed = terminalServerMessageSchema.safeParse(JSON.parse(String(event.data)));
      if (!parsed.success) return;
      const message: TerminalServerMessage = parsed.data;
      if (message.type === 'output') terminal.write(message.data);
      else if (message.type === 'secret_requested')
        setRequest({ request_id: message.request_id, label: message.label });
      else if (message.type === 'refused') setRefused(message.reason);
      else if (message.type === 'exit') setEnded(true);
    });
    return () => {
      ws.close();
      terminal.dispose();
    };
  }, [terminalId]);

  const submit = () => {
    const reason = refuseSetupLine(line);
    setRefused(reason);
    if (reason !== null) return;
    socket.current?.send(JSON.stringify({ type: 'line', text: line }));
    setLine('');
  };

  return (
    <div className="flex flex-col gap-2.5 border-b-2 border-divider px-5 py-4">
      <div className="flex items-center gap-2">
        <strong className="text-[13px]">Setup agent running</strong>
        <span className="text-xs text-neutral-700">When Claude needs a password it asks in a masked field.</span>
        <Button
          className="ml-auto px-2.5 py-1 text-xs"
          onClick={() => {
            drafts.delete(terminalId);
            onClose();
          }}
        >
          Close
        </Button>
      </div>
      <div ref={host} className="min-h-40 overflow-hidden bg-black p-1.5" />
      {request && (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            answer.mutate(
              { terminalId, requestId: request.request_id, value: secret },
              {
                onSuccess: () => {
                  setSecret('');
                  setRequest(null);
                },
              },
            );
          }}
        >
          <label className="flex-1 text-xs font-extrabold">
            {request.label}
            <input
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              className="mt-1 w-full border-[1.5px] border-text bg-bg px-2 py-1.5 font-mono text-[13px] text-text"
            />
          </label>
          <Button variant="primary" type="submit" disabled={secret === '' || answer.isPending}>
            Send
          </Button>
        </form>
      )}
      <div className="flex gap-2">
        <input
          aria-label="Message to Claude"
          disabled={ended}
          value={line}
          maxLength={SETUP_LINE_MAX}
          placeholder={
            ended
              ? 'The terminal ended. Close it and open it again.'
              : 'Type a line and press Enter (Enter alone confirms a prompt)'
          }
          aria-invalid={refused !== null}
          aria-describedby={refused === null ? undefined : 'setup-line-refused'}
          onChange={(event) => {
            setLine(event.target.value);
            setRefused(null);
          }}
          onKeyDown={(event) => event.key === 'Enter' && submit()}
          className="flex-1 border-[1.5px] border-text bg-bg px-2 py-1.5 font-mono text-[13px] text-text"
        />
        <Button disabled={ended} onClick={submit}>
          Send
        </Button>
      </div>
      {refused && (
        <div id="setup-line-refused" role="alert" className="text-xs text-accent-700">
          {refused}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 text-[11px] text-neutral-700">
        Try:
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            className="cursor-pointer border border-divider bg-transparent px-1.5 py-0.5 text-[11px] text-text"
            onClick={() => setLine(example)}
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}
