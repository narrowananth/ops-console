import { useEffect, useState } from 'react';
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
 * the agent clones into an anonymous Session. Datadog fills the URL when its logs carry `git.repository_url`.
 */
export function CodeSource({ service }: { service: ServiceRef }) {
  const repos = useRepos();
  const patch = usePatchService();
  const find = useFindCode();
  const unlinked = service.repo_id === null && service.repo_url === null;
  const { mutate } = find;
  useEffect(() => {
    if (!unlinked || looked.has(service.id)) return;
    looked.add(service.id);
    mutate(service.id);
  }, [unlinked, service.id, mutate]);
  const [url, setUrl] = useState(service.repo_url ?? '');
  const list = ascending(repos.data?.data ?? [], (repo) => repo.name);
  const options = [
    { value: NONE, label: 'No local Repo', description: 'Verify and Fix clone the Git URL instead' },
    ...list.map((repo) => ({ value: repo.id, label: repo.name, description: repo.path })),
  ];
  const changed = url.trim() !== (service.repo_url ?? '');
  const save = () => patch.mutate({ id: service.id, repo_url: url.trim() === '' ? null : url.trim() });

  return (
    <section
      aria-label="Code"
      className="flex flex-col gap-2 rounded-xl border border-line bg-card px-4 py-3 text-xs shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong className="w-20 flex-none text-[12px]">Local Repo</strong>
        <Dropdown
          label={`Repo for ${service.name}`}
          caption="Repo"
          opens="down"
          heading={`Code for ${service.name}`}
          className="w-64"
          listClassName="w-80"
          value={service.repo_id ?? NONE}
          options={options}
          disabled={patch.isPending || repos.isPending}
          onChange={(value) => patch.mutate({ id: service.id, repo_id: value === NONE ? null : value })}
        />
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (changed) save();
        }}
      >
        <label htmlFor={`repo-url-${service.id}`} className="w-20 flex-none text-[12px] font-bold">
          Git URL
        </label>
        <input
          id={`repo-url-${service.id}`}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="github.com/owner/repo"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-divider bg-bg px-2.5 py-1.5 font-mono text-xs text-text outline-none focus:border-accent-400"
        />
        <Button type="submit" className="px-2.5 py-1 text-xs" disabled={!changed || patch.isPending}>
          Save
        </Button>
      </form>
      <p className="m-0 text-[11px] text-neutral-700">
        {service.repo_id
          ? 'The agent works in the local Repo.'
          : service.repo_url
            ? 'No local Repo: the agent clones the Git URL into an anonymous Session.'
            : find.isPending
              ? `Looking for ${service.name}'s code…`
              : `Not found by itself. Pick the local Repo with ${service.name}'s code, or give its Git URL once; it is kept.`}
      </p>
      {unlinked && find.data && find.data.tried.length > 0 && (
        <details className="text-[11px] text-neutral-700">
          <summary className="cursor-pointer">Where it looked ({find.data.tried.length})</summary>
          <ul className="m-0 mt-1 flex list-disc flex-col gap-0.5 pl-5 font-mono">
            {find.data.tried.map((place) => (
              <li key={place}>{place}</li>
            ))}
          </ul>
          <p className="m-0 mt-1">
            Datadog fills it by itself when the logs carry a <code className="font-mono">git.repository_url</code> tag.
          </p>
        </details>
      )}
      {unlinked && !find.isPending && (
        <Button className="self-start px-2.5 py-1 text-xs" onClick={() => mutate(service.id)}>
          Look again
        </Button>
      )}
      {find.error && (
        <span role="alert" className="text-[11px] text-accent-700">
          {find.error.message}
        </span>
      )}
      {patch.error && (
        <span role="alert" className="text-[11px] text-accent-700">
          {patch.error.message}
        </span>
      )}
    </section>
  );
}
