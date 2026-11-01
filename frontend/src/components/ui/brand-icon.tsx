import { ConnectionType, ConnectorId, GitHost } from '@ops-console/shared';
import { BRANDS, type BrandSlug } from './brands';

export const CONNECTION_BRAND: Record<ConnectionType, BrandSlug> = {
  [ConnectionType.Postgres]: 'postgresql',
  [ConnectionType.Mongodb]: 'mongodb',
  [ConnectionType.Redis]: 'redis',
  [ConnectionType.Clickhouse]: 'clickhouse',
  [ConnectionType.Firebase]: 'firebase',
  [ConnectionType.Kafka]: 'apachekafka',
};

export const CONNECTOR_BRAND: Record<ConnectorId, BrandSlug> = {
  [ConnectorId.Datadog]: 'datadog',
  [ConnectorId.Jira]: 'jira',
  [ConnectorId.Github]: 'github',
  [ConnectorId.Gitlab]: 'gitlab',
  [ConnectorId.Bitbucket]: 'bitbucket',
  [ConnectorId.Slack]: 'slack',
  [ConnectorId.Sentry]: 'sentry',
  [ConnectorId.Shopify]: 'shopify',
};

/** Words in an MCP Server's name or command that say whose it is; the first match wins. */
const SERVER_HINTS: [RegExp, BrandSlug][] = [
  [/github/, 'github'],
  [/gitlab/, 'gitlab'],
  [/bitbucket/, 'bitbucket'],
  [/jira/, 'jira'],
  [/atlassian|confluence/, 'atlassian'],
  [/datadog|\bpup\b/, 'datadog'],
  [/slack/, 'slack'],
  [/sentry/, 'sentry'],
  [/shopify/, 'shopify'],
  [/mongo/, 'mongodb'],
  [/postgres|\bpg[-_]|\bpg$/, 'postgresql'],
  [/mysql/, 'mysql'],
  [/sqlite/, 'sqlite'],
  [/redis/, 'redis'],
  [/clickhouse/, 'clickhouse'],
  [/firebase|firestore/, 'firebase'],
  [/kafka/, 'apachekafka'],
  [/notion/, 'notion'],
  [/linear/, 'linear'],
  [/figma/, 'figma'],
  [/stripe/, 'stripe'],
  [/vercel/, 'vercel'],
  [/supabase/, 'supabase'],
  [/docker/, 'docker'],
  [/kubernetes|\bk8s\b|kubectl/, 'kubernetes'],
  [/gcloud|google-cloud|\bgcp\b/, 'googlecloud'],
];

/** Whose mark an MCP Server gets, from its name then its command or URL; the MCP mark when nothing matches. */
export function serverBrand(name: string, target = ''): BrandSlug {
  for (const text of [name.toLowerCase(), target.toLowerCase()]) {
    const hit = SERVER_HINTS.find(([pattern]) => pattern.test(text));
    if (hit) return hit[1];
  }
  return 'modelcontextprotocol';
}

/** Light brand colours (ClickHouse yellow) take a dark mark; the rest take white. */
function inkOn(hex: string): string {
  const channel = (at: number) => Number.parseInt(hex.slice(at, at + 2), 16) / 255;
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5) > 0.6 ? '#161414' : '#ffffff';
}

const SIZES = {
  xs: 'size-4.5 rounded-[5px] p-0.75',
  sm: 'size-6 rounded-md p-1',
  md: 'size-8 rounded-lg p-1.5',
  lg: 'size-11 rounded-xl p-2.5',
};

/** A service's mark on a tile of its brand colour, in front of its name. */
export function BrandIcon({ brand, size = 'md' }: { brand: BrandSlug; size?: keyof typeof SIZES }) {
  const { title, hex, path } = BRANDS[brand];
  return (
    <span
      title={title}
      className={`inline-flex flex-none items-center justify-center shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)] ${SIZES[size]}`}
      style={{ background: hex }}
    >
      <svg viewBox="0 0 24 24" className="size-full" fill={inkOn(hex)} aria-hidden>
        <path d={path} />
      </svg>
    </span>
  );
}

const HOST_BRAND: Partial<Record<GitHost, BrandSlug>> = {
  [GitHost.Github]: 'github',
  [GitHost.Gitlab]: 'gitlab',
  [GitHost.Bitbucket]: 'bitbucket',
};

/** A Repo's Git host mark; a folder for a local Repo. */
export function RepoIcon({ host, size = 'md' }: { host: GitHost; size?: keyof typeof SIZES }) {
  const brand = HOST_BRAND[host];
  if (brand) return <BrandIcon brand={brand} size={size} />;
  return (
    <span
      title="Local folder"
      className={`inline-flex flex-none items-center justify-center bg-neutral-200 text-neutral-700 ${SIZES[size]}`}
    >
      <svg viewBox="0 0 24 24" className="size-full" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
