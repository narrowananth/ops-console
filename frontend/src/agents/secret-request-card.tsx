import { useState } from 'react';
import { Button } from '../components/ui/button';
import { useAnswerSecretRequest, useSecretRequests } from '../lib/queries';

function SecretField({ sessionId, requestId, label }: { sessionId: string; requestId: string; label: string }) {
  const [value, setValue] = useState('');
  const [failed, setFailed] = useState(false);
  const answer = useAnswerSecretRequest(sessionId);
  return (
    <li aria-label={`Secret needed: ${label}`} className="list-none">
      <form
        className="flex items-end gap-2.5 rounded-xl border border-accent-300 bg-accent-100 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          // Sent once. The field is cleared and the mutation reset either way, since the mutation keeps what it was
          // given until reset.
          setFailed(false);
          answer.mutate(
            { requestId, value },
            {
              onError: () => setFailed(true),
              onSettled: () => {
                setValue('');
                answer.reset();
              },
            },
          );
        }}
      >
        <label className="flex-1 text-xs font-semibold text-accent-900">
          {label}
          <input
            type="password"
            name="secret"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="mt-1.5 w-full border border-divider bg-card px-3 py-2 font-mono text-[13px] text-text"
          />
          <span className="mt-1 block font-normal text-neutral-700">
            The agent never sees it: it gets a placeholder, and the console stores the secret in the Keychain when a
            Connection is saved.
          </span>
        </label>
        <Button variant="primary" type="submit" disabled={value === '' || answer.isPending}>
          Send
        </Button>
      </form>
      {failed && (
        <div role="alert" className="mt-1 text-xs text-accent-700">
          The secret was not stored. Ask the agent again.
        </div>
      )}
    </li>
  );
}

/** The masked fields the Session's agent asked for. The typed value goes to the daemon and is never shown again. */
export function SecretRequestCards({ sessionId }: { sessionId: string }) {
  const requests = useSecretRequests(sessionId);
  if (!requests.data || requests.data.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {requests.data.map((request) => (
        <SecretField
          key={request.request_id}
          sessionId={sessionId}
          requestId={request.request_id}
          label={request.label}
        />
      ))}
    </ul>
  );
}
