import { Empty } from '../components/ui/empty';
import { useNeedsYouCount } from '../lib/queries';
import { useAddress } from '../lib/remember';
import { ListPage, SessionsIcon } from './list-page';
import { SessionView } from './session-view';
import { SessionsPane } from './sessions-pane';

/** The Sessions inbox on the left, the picked Session on the right. The pick lives in the address. */
export function SessionsPage() {
  const [address, setAddress] = useAddress('session', 'message');
  const sessionId = address.session;
  const waiting = useNeedsYouCount();
  return (
    <ListPage
      page="sessions"
      title="Sessions"
      tip="Your conversations with the agent, grouped by Repo"
      icon={<SessionsIcon />}
      badge={waiting}
      list={<SessionsPane selected={sessionId} onSelect={(id) => setAddress({ session: id, message: null })} />}
    >
      {sessionId ? (
        <SessionView key={sessionId} id={sessionId} onGone={() => setAddress({ session: null }, { replace: true })} />
      ) : (
        <Empty>Pick a Session, or start one on a branch.</Empty>
      )}
    </ListPage>
  );
}
