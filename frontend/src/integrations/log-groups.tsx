import {
  AWS_REGIONS,
  type AwsProfile,
  type Connector,
  HealthStatus,
  type LogGroupPick,
  logGroupSchema,
} from '@ops-console/shared';
import { useState } from 'react';
import { z } from 'zod';
import { Button, Spinner } from '../components/ui/button';
import { Dropdown } from '../components/ui/dropdown';
import { useAwsProfiles, useLogGroups } from '../lib/queries';
import { ascending } from '../lib/sort';
import { ChoiceCard, type ConnectPane, SignInStep } from './sign-in-step';

const savedSchema = z.object({
  profile: z.string().catch(''),
  region: z.string().catch(''),
  log_groups: z.array(logGroupSchema).catch([]),
});

/** The profile, region and log groups the Connector keeps, across a Disconnect; empty until chosen. */
export function savedCloudWatch(connector: Connector) {
  return savedSchema.parse(connector.config);
}

/** A new pick is the Service its group's last path segment names, in prod. */
const pickOf = (name: string): LogGroupPick => ({
  name,
  service: name.split('/').filter(Boolean).at(-1) ?? name,
  env: 'prod',
});

/** The first Service name and env two picked groups share, or null. */
function repeated(picks: LogGroupPick[]): LogGroupPick | null {
  const seen = new Set<string>();
  for (const pick of picks) {
    const key = JSON.stringify([pick.service.trim(), pick.env.trim()]);
    if (seen.has(key)) return pick;
    seen.add(key);
  }
  return null;
}

const trimmed = (pick: LogGroupPick): LogGroupPick => ({
  name: pick.name,
  service: pick.service.trim(),
  env: pick.env.trim(),
});

const FIELD = 'w-full border border-divider bg-card px-2 py-1.5 font-mono text-[13px] text-text';

/** The profiles on this Mac for the picker: `default` first, the rest A to Z. */
const profileOrder = (profiles: AwsProfile[]): AwsProfile[] => [
  ...profiles.filter((profile) => profile.name === 'default'),
  ...ascending(
    profiles.filter((profile) => profile.name !== 'default'),
    (profile) => profile.name,
  ),
];

/**
 * The AWS profile and region to sign in with, then the log groups to read. Each picked group is one Service, named by
 * its last path segment in prod until the operator edits it. Connect signs the profile in when it needs it.
 */
export function CloudWatchStep({ connector, pending, cancelling, onConnect, onCancel }: ConnectPane) {
  const saved = savedCloudWatch(connector);
  const profiles = useAwsProfiles();
  const [profilePick, setProfilePick] = useState<string | null>(null);
  const [regionPick, setRegionPick] = useState<string | null>(null);
  const found = profileOrder(profiles.data ?? []);
  const profile = profilePick ?? (saved.profile || found[0]?.name || 'default');
  // A profile with a region of its own brings it; the region the Connector kept stays while its profile does.
  const region =
    regionPick ??
    (profile === saved.profile && saved.region !== ''
      ? saved.region
      : (found.find((one) => one.name === profile)?.region ?? ''));
  const regions = ascending(
    AWS_REGIONS.includes(region as (typeof AWS_REGIONS)[number]) || region === ''
      ? AWS_REGIONS
      : [...AWS_REGIONS, region],
    (name) => name,
  );
  const waiting = connector.sign_in !== null;
  return (
    <>
      <ChoiceCard label="AWS profile and region">
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1 text-xs">
            <span
              className="font-semibold"
              title="The AWS CLI profile Connect signs in and the console reads logs with."
            >
              AWS profile
            </span>
            {profiles.isPending && (
              <p role="status" className="m-0 text-neutral-700">
                Reading profiles…
              </p>
            )}
            {profiles.isError && (
              <p role="alert" className="m-0 text-accent-700">
                {profiles.error.message}
              </p>
            )}
            {profiles.isSuccess && found.length === 0 && (
              <p className="m-0 text-neutral-700">No AWS profile on this Mac. Connect creates `default`.</p>
            )}
            {found.length > 0 && (
              <Dropdown
                label="AWS profile"
                value={profile}
                disabled={waiting}
                options={found.map((one) => ({
                  value: one.name,
                  label: one.name,
                  description: one.region ?? undefined,
                }))}
                onChange={(name) => {
                  setProfilePick(name);
                  setRegionPick(null);
                }}
              />
            )}
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <span className="font-semibold" title="The one AWS region the log groups are in.">
              Region
            </span>
            <Dropdown
              label="Region"
              value={region}
              disabled={waiting}
              options={[
                ...(region === '' ? [{ value: '', label: 'Choose a region' }] : []),
                ...regions.map((name) => ({ value: name, label: name })),
              ]}
              onChange={setRegionPick}
            />
          </div>
        </div>
        <p className="m-0 text-xs text-neutral-700">
          Use a profile with the <code className="font-mono">CloudWatchLogsReadOnlyAccess</code> policy. The console
          only reads logs.
        </p>
      </ChoiceCard>
      <SignInStep
        connector={connector}
        pending={pending}
        cancelling={cancelling}
        onConnect={() => onConnect({ profile, region })}
        onCancel={onCancel}
        blocked={
          profiles.isPending ? 'Reading the AWS profiles' : region === '' ? 'Choose the region first' : undefined
        }
      />
      {connector.status !== HealthStatus.Off && (
        <LogGroupsStep
          connector={connector}
          profile={profile}
          region={region}
          pending={pending}
          onConnect={(log_groups) => onConnect({ profile, region, log_groups })}
        />
      )}
    </>
  );
}

/** The log groups the profile sees in the region, picked here and read once the Connector is signed in. */
function LogGroupsStep({
  connector,
  profile,
  region,
  pending,
  onConnect,
}: {
  connector: Connector;
  profile: string;
  region: string;
  pending: boolean;
  onConnect: (logGroups: LogGroupPick[]) => void;
}) {
  const saved = savedCloudWatch(connector);
  const [picks, setPicks] = useState<LogGroupPick[]>(saved.log_groups);
  const [asked, setAsked] = useState<{ profile: string; region: string } | null>(null);
  const [needle, setNeedle] = useState('');
  const groups = useLogGroups(asked);
  const signIn = connector.sign_in;
  const connected = connector.status === HealthStatus.Ok;
  const checking = connector.status === HealthStatus.Checking;
  const named = profile !== '' && region !== '';
  const twice = repeated(picks);
  const blank = picks.some((pick) => pick.service.trim() === '' || pick.env.trim() === '');
  const ready = named && picks.length > 0 && !twice && !blank;
  const looking = groups.isFetching;
  const find = () => {
    if (asked?.profile === profile && asked.region === region) void groups.refetch();
    else setAsked({ profile, region });
  };
  const edit = (name: string, change: Partial<LogGroupPick>) =>
    setPicks(picks.map((pick) => (pick.name === name ? { ...pick, ...change } : pick)));
  const toggle = (name: string) =>
    setPicks(
      picks.some((pick) => pick.name === name) ? picks.filter((pick) => pick.name !== name) : [...picks, pickOf(name)],
    );
  const lookup = needle.trim().toLowerCase();
  const shown = ascending(
    (groups.data ?? []).filter((name) => name.toLowerCase().includes(lookup)),
    (name) => name,
  );
  const detail = connected
    ? `Reading ${saved.log_groups.length} ${saved.log_groups.length === 1 ? 'log group' : 'log groups'} in ${saved.region} as ${saved.profile}.`
    : 'Pick the log groups to read once the profile is signed in.';

  return (
    <ChoiceCard label="Log groups to read">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold">Log groups</span>
            <Button
              className="ml-auto px-2.5 py-1 text-xs"
              title="Read the log groups this profile sees in this region"
              disabled={!named || looking || signIn !== null}
              onClick={find}
            >
              {looking && <Spinner />}
              Find log groups
            </Button>
          </div>
          {looking && (
            <p role="status" className="m-0 text-xs text-neutral-700">
              Reading log groups…
            </p>
          )}
          {!looking && groups.isError && (
            <p role="alert" className="m-0 text-xs text-accent-700">
              {groups.error.message}
            </p>
          )}
          {!looking && groups.isSuccess && groups.data.length === 0 && (
            <p className="m-0 text-xs text-neutral-700">
              {asked?.profile} sees no log groups in {asked?.region}.
            </p>
          )}
          {!looking && groups.isSuccess && groups.data.length > 0 && (
            <>
              <input
                type="search"
                aria-label="Filter log groups"
                value={needle}
                onChange={(event) => setNeedle(event.target.value)}
                placeholder="Filter log groups"
                className={FIELD}
              />
              <ul
                aria-label="Log groups"
                className="m-0 flex max-h-40 list-none flex-col overflow-y-auto rounded-md border border-line p-1"
              >
                {shown.map((name) => (
                  <li key={name}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 font-mono text-xs hover:bg-neutral-200">
                      <input
                        type="checkbox"
                        checked={picks.some((pick) => pick.name === name)}
                        onChange={() => toggle(name)}
                        className="accent-accent"
                      />
                      {name}
                    </label>
                  </li>
                ))}
                {shown.length === 0 && <li className="px-1.5 py-1 text-xs text-neutral-700">None match.</li>}
              </ul>
            </>
          )}
        </div>

        {picks.length > 0 && (
          <ul aria-label="Picked log groups" className="m-0 flex list-none flex-col gap-2 p-0">
            {ascending(picks, (pick) => pick.name).map((pick) => (
              <li
                key={pick.name}
                aria-label={pick.name}
                className="flex flex-col gap-1.5 rounded-md bg-neutral-200 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold">{pick.name}</span>
                  <button
                    type="button"
                    className="cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-accent-700 hover:text-accent-600"
                    onClick={() => toggle(pick.name)}
                  >
                    Remove
                  </button>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
                  <label className="flex flex-col gap-0.5 text-xs">
                    <span className="text-neutral-700">Service name</span>
                    <input
                      value={pick.service}
                      onChange={(event) => edit(pick.name, { service: event.target.value })}
                      spellCheck={false}
                      className={FIELD}
                    />
                  </label>
                  <label className="flex flex-col gap-0.5 text-xs">
                    <span className="text-neutral-700">Env</span>
                    <input
                      value={pick.env}
                      onChange={(event) => edit(pick.name, { env: event.target.value })}
                      spellCheck={false}
                      className={FIELD}
                    />
                  </label>
                </div>
              </li>
            ))}
          </ul>
        )}
        {twice && (
          <p role="alert" className="m-0 text-xs text-accent-700">
            Two log groups are the Service {twice.service.trim()} in {twice.env.trim()}. Change a name or an env.
          </p>
        )}

        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 text-xs text-neutral-700">{detail}</div>
          <Button
            variant="primary"
            className="shrink-0"
            title={
              ready
                ? 'Check the profile and the log groups, and start reading them'
                : 'Needs at least one log group, each with its own Service name and env'
            }
            disabled={pending || checking || signIn !== null || !ready}
            onClick={() => onConnect(picks.map(trimmed))}
          >
            Read these log groups
          </Button>
        </div>
      </div>
    </ChoiceCard>
  );
}
