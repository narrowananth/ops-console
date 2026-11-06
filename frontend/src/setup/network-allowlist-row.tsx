import { allNetworkDomains, networkDomainSchema } from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { useAddNetworkDomain, useNetworkAllowlist, useRemoveNetworkDomain } from '../lib/queries';
import { ascending } from '../lib/sort';

/** The hosts an agent run's commands may reach. Built-in is read-only; the operator edits Added by you. */
export function NetworkAllowlistRow() {
  const read = useNetworkAllowlist();
  const add = useAddNetworkDomain();
  const remove = useRemoveNetworkDomain();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const list = read.data;
  const count = list ? allNetworkDomains(list).length : null;
  // The Repos' hosts are built in too; the page does not say which Repo has which.
  const builtIn = list ? [...new Set([...list.built_in, ...list.from_repos.map((entry) => entry.domain)])] : [];
  const submit = () => {
    const checked = networkDomainSchema.safeParse(value);
    if (!checked.success) {
      setRefusal(checked.error.issues[0]?.message ?? 'Enter a hostname.');
      return;
    }
    add.mutate(checked.data, { onSuccess: () => setValue('') });
  };
  const message = refusal ?? add.error?.message;
  return (
    <li aria-label="Network allowlist" className="flex flex-col gap-2 rounded-lg bg-bg px-3 py-2.5">
      <div className="flex items-center gap-2">
        {list ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-xs font-bold text-text"
          >
            <span aria-hidden>{open ? '▾' : '▸'}</span>
            Network allowlist: {count} {count === 1 ? 'domain' : 'domains'}
          </button>
        ) : (
          <strong className="flex-1">Network allowlist</strong>
        )}
        {!list && !read.error && (
          <span className="rounded-full bg-neutral-200 px-2 py-0.5 font-mono text-xs text-neutral-700">… checking</span>
        )}
      </div>
      <span className="text-neutral-700">The only hosts an agent run's commands can reach.</span>
      {read.error && (
        <div className="flex items-center gap-2">
          <span role="alert" className="text-accent-700">
            Could not read the list
          </span>
          <Button className="px-3 py-1.25 text-xs" onClick={() => read.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {list && open && (
        <div className="flex flex-col gap-3">
          <DomainGroup
            label="Built-in"
            domains={ascending(builtIn, (domain) => domain).map((domain) => ({ domain }))}
          />
          <DomainGroup
            label="Added by you"
            empty="None added"
            domains={ascending(list.added, (domain) => domain).map((domain) => ({ domain }))}
            onRemove={(domain) => remove.mutate(domain)}
          />
          <form
            className="flex flex-col gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="flex gap-2">
              <input
                aria-label="Domain"
                value={value}
                placeholder="npm.example.com"
                onChange={(event) => {
                  setValue(event.target.value);
                  setRefusal(null);
                  add.reset();
                }}
                className="min-w-0 flex-1 rounded-md border border-divider bg-card px-2.5 py-1.5 text-xs text-text outline-none focus:border-accent-400"
              />
              <Button type="submit" className="px-3 py-1.25 text-xs" disabled={add.isPending}>
                Add
              </Button>
            </div>
            {message && (
              <span role="alert" className="text-accent-700">
                {message}
              </span>
            )}
            <span className="text-neutral-700">
              *.example.com covers subdomains. Add example.com too if you need it.
            </span>
          </form>
          {remove.error && (
            <span role="alert" className="text-accent-700">
              {remove.error.message}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

/** One group of the Network allowlist; only a group with `onRemove` has remove buttons. `empty` is for a group that can be. */
function DomainGroup({
  label,
  empty,
  domains,
  onRemove,
}: {
  label: string;
  empty?: string;
  domains: { domain: string }[];
  onRemove?: (domain: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-neutral-700">{label}</span>
      <ul
        aria-label={label}
        className={`m-0 flex list-none p-0 font-mono text-xs ${onRemove ? 'flex-col gap-0.5' : 'flex-wrap gap-x-1 gap-y-0.5'}`}
      >
        {domains.length === 0 && <li className="text-neutral-700">{empty}</li>}
        {domains.map(({ domain }) => (
          <li
            key={domain}
            className={onRemove ? 'flex items-center gap-2' : 'after:content-[","] last:after:content-none'}
          >
            <span>{domain}</span>
            {onRemove && (
              <Button
                variant="ghost"
                className="ml-auto px-2 py-0.5 text-xs"
                aria-label={`Remove ${domain}`}
                onClick={() => onRemove(domain)}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
