import { HealthStatus } from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { ChoiceCard, type ConnectPane } from './sign-in-step';

const KEY_PAGE = 'https://dashboard.render.com/u/settings?add-api-key';

/** Render's one step: the API key, pasted from the dashboard. It goes to the Keychain and the field empties. */
export function RenderStep({ connector, pending, cancelling, onConnect, onCancel }: ConnectPane) {
  const [key, setKey] = useState('');
  const waiting = connector.sign_in !== null;
  const connected = connector.status !== HealthStatus.Off;
  return (
    <ChoiceCard label="API key">
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-semibold">Render API key</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          placeholder="rnd_…"
          disabled={waiting}
          onChange={(event) => setKey(event.target.value)}
          className="w-full border border-divider bg-card px-2 py-1.5 font-mono text-[13px] text-text"
        />
      </label>
      <p className="m-0 text-xs text-neutral-700">
        <a href={KEY_PAGE} target="_blank" rel="noreferrer" className="underline">
          Create an API key in the Render dashboard
        </a>
        . The console keeps it in the macOS Keychain and never shows it again.
        {connected && ' Paste a new key to replace the one it holds.'}
      </p>
      {connector.status_detail && !waiting && (
        <div role="alert" className="text-xs text-accent-700">
          {connector.status_detail}
        </div>
      )}
      <div className="flex gap-2">
        <Button
          variant={connected ? 'secondary' : 'primary'}
          disabled={pending || waiting || key.trim() === ''}
          onClick={() => {
            onConnect({ api_key: key.trim() });
            // The key is gone from the page once sent; a refused one is typed again.
            setKey('');
          }}
        >
          {waiting ? 'Waiting…' : connected ? 'Reconnect' : 'Connect'}
        </Button>
        {waiting && (
          <Button title="Stop waiting for this connection" disabled={cancelling} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </ChoiceCard>
  );
}
