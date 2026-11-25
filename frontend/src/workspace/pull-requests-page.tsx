import { Empty } from '../components/ui/empty';
import { useAddress } from '../lib/remember';
import { ListPage, PullRequestIcon } from './list-page';
import { PullRequestView } from './pull-request-view';
import { PullRequestsPane } from './pull-requests-pane';

/** `<repo id>/<number>` from the address. */
function parsePull(value: string | null): { repoId: string; number: number } | null {
  const at = value?.lastIndexOf('/') ?? -1;
  if (value === null || at < 1) return null;
  const number = Number(value.slice(at + 1));
  return Number.isInteger(number) && number > 0 ? { repoId: value.slice(0, at), number } : null;
}

/** The pull request list on the left, the picked pull request on the right. The pick lives in the address. */
export function PullRequestsPage() {
  const [address, setAddress] = useAddress('pr');
  const pull = parsePull(address.pr);
  return (
    <ListPage
      page="pull-requests"
      title="Pull requests"
      tip="Open pull requests on your Git hosts: review, comment, and let the agent review or address comments"
      icon={<PullRequestIcon />}
      list={
        <PullRequestsPane selected={pull} onSelect={(next) => setAddress({ pr: `${next.repoId}/${next.number}` })} />
      }
    >
      {pull ? (
        <PullRequestView key={`${pull.repoId}#${pull.number}`} repoId={pull.repoId} number={pull.number} />
      ) : (
        <Empty>Pick a pull request.</Empty>
      )}
    </ListPage>
  );
}
