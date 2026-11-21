import { ConnectorId, type LogSource } from '@ops-console/shared';
import { useEffect } from 'react';
import { Button } from '../components/ui/button';
import { Dropdown } from '../components/ui/dropdown';
import { useFindCode, usePatchService, useRepos } from '../lib/queries';
import { ascending } from '../lib/sort';

const NONE = 'none';

/** Services looked for on this page already; opening the card again does not look again. */
const looked = new Set<string>();

type ServiceRef = { id: string; name: string; repo_id: string | null; repo_url: string | null };

/**
 * Where a Service's code is, for Verify and Fix: a local Repo, else the Git URL on GitHub, GitLab or Bitbucket that
 * the agent clones into an anonymous Session. Datadog fills the URL when its logs carry `git.repository_url`;
 * The other sources carry none, so the Repo is found by the Service's name or linked by hand.
 */
export function CodeSource({ service, source }: { service: ServiceRef; source: LogSource }) {
  const repos = useRepos();
  const patch = usePatchService();
  const find = useFindCode();
  const unlinked = service.repo_id === null && service.repo_url === null;
  // No local Repo yet: look for the one whose source serves this Service's Routes, once per page.
  const noLocal = service.repo_id === null;
  const { mutate } = find;
  useEffect(() => {
    if (!noLocal || looked.has(service.id)) return;
    looked.add(service.id);
    mutate(service.id);
  }, [noLocal, service.id, mutate]);
  const list = ascending(repos.data?.data ?? [], (repo) => repo.name);
  const options = [
    { value: NONE, label: 'No local Repo', description: 'No code linked for this Service' },
    ...list.map((repo) => ({ value: repo.id, label: repo.name, description: repo.path })),
  ];

  return (
    <section
      aria-label="Code"
      className="flex flex-col gap-2 rounded-xl border border-line bg-card px-4 py-3 text-xs shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong className="w-20 flex-none text-xs">Local Repo</strong>
        <Dropdown
          label={`Repo for ${service.name}`}
          caption="Repo"
          opens="down"
          heading={`Code for ${service.name}`}
          searchable
          className="w-64"
          listClassName="w-80"
          value={service.repo_id ?? NONE}
          options={options}
          disabled={patch.isPending || repos.isPending}
          onChange={(value) => patch.mutate({ id: service.id, repo_id: value === NONE ? null : value })}
        />
      </div>
      <p className="m-0 text-xs text-neutral-700">
        {service.repo_id
          ? 'The agent works in the local Repo.'
          : find.isPending
            ? `Looking for the local Repo that serves ${service.name}'s Routes…`
            : service.repo_url
              ? "No local Repo found: the agent clones the Service's Git repo into an anonymous Session. Pick one above to use it."
              : `No imported Repo serves ${service.name}'s Routes. Pick the local Repo with its code.`}
      </p>
      {unlinked && find.data && find.data.tried.length > 0 && (
        <details className="text-xs text-neutral-700">
          <summary className="cursor-pointer">Where it looked ({find.data.tried.length})</summary>
          <ul className="m-0 mt-1 flex list-disc flex-col gap-0.5 pl-5 font-mono">
            {find.data.tried.map((place) => (
              <li key={place}>{place}</li>
            ))}
          </ul>
          {source === ConnectorId.Datadog && (
            <p className="m-0 mt-1">
              Datadog fills it by itself when the logs carry a <code className="font-mono">git.repository_url</code>{' '}
              tag.
            </p>
          )}
        </details>
      )}
      {unlinked && !find.isPending && (
        <Button className="self-start px-2.5 py-1 text-xs" onClick={() => mutate(service.id)}>
          Look again
        </Button>
      )}
      {find.error && (
        <span role="alert" className="text-xs text-accent-700">
          {find.error.message}
        </span>
      )}
      {patch.error && (
        <span role="alert" className="text-xs text-accent-700">
          {patch.error.message}
        </span>
      )}
    </section>
  );
}
