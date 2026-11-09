import { z } from 'zod';

/**
 * The hosts every agent run's commands may reach, whatever else is on its Network allowlist: Git on GitHub and the
 * package registries a repo's build and commit hooks fetch from (npm and Yarn, crates.io, the Go module proxy, Maven
 * Central, Gradle, PyPI, RubyGems).
 */
export const BUILT_IN_NETWORK_DOMAINS = [
  'github.com',
  'api.github.com',
  '*.githubusercontent.com',
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'crates.io',
  '*.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'repo.maven.apache.org',
  'repo1.maven.org',
  'plugins.gradle.org',
  'services.gradle.org',
  'downloads.gradle.org',
  'pypi.org',
  'files.pythonhosted.org',
  'rubygems.org',
  'index.rubygems.org',
  // The Connectors' own APIs (Git hosts, Atlassian, Datadog, Slack, Sentry, Shopify), by API host: never an ingest or
  // webhook host, which takes data from anyone.
  'bitbucket.org',
  'api.bitbucket.org',
  'gitlab.com',
  'api.atlassian.com',
  'mcp.atlassian.com',
  '*.atlassian.net',
  'api.datadoghq.com',
  'app.datadoghq.com',
  'mcp.datadoghq.com',
  'api.datadoghq.eu',
  'api.us3.datadoghq.com',
  'api.us5.datadoghq.com',
  'api.ap1.datadoghq.com',
  'api.ddog-gov.com',
  'slack.com',
  'mcp.slack.com',
  'sentry.io',
  'mcp.sentry.dev',
  'shopify.dev',
  '*.myshopify.com',
] as const;

const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/** One operator domain: a hostname, or `*.` and a hostname of two labels or more. Trimmed and lowercased. */
export const networkDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .superRefine((domain, ctx) => {
    const refuse = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (domain === '') return refuse('Enter a hostname, such as npm.example.com.');
    if (domain === '*') return refuse('A bare * would allow every host.');
    if (domain.includes('://')) return refuse('Enter the hostname only, without https://.');
    if (domain.includes('/')) return refuse('Enter the hostname only, without a path.');
    if (domain.includes(':')) return refuse('Enter the hostname only, without a port.');
    const wildcard = domain.startsWith('*.');
    const host = wildcard ? domain.slice(2) : domain;
    if (domain.length > 253 || !HOSTNAME.test(host)) {
      return refuse('Enter a hostname, such as npm.example.com or *.example.com.');
    }
    if (/^\d+$/.test(host.slice(host.lastIndexOf('.') + 1))) return refuse('Enter a hostname, not an IP address.');
    if (wildcard && !host.includes('.')) return refuse(`*.${host} would allow a whole top-level domain.`);
  });

export const addNetworkDomainSchema = z.object({ domain: networkDomainSchema });

/** The Network allowlist in its three groups. `from_repos` names a Repo that has the host. */
export const networkAllowlistSchema = z.object({
  built_in: z.array(z.string()),
  from_repos: z.array(z.object({ domain: z.string(), repo: z.string() })),
  added: z.array(z.string()),
});

export type NetworkAllowlist = z.infer<typeof networkAllowlistSchema>;

/** Every distinct domain across the three groups. */
export function allNetworkDomains(list: NetworkAllowlist): string[] {
  return [...new Set([...list.built_in, ...list.from_repos.map((entry) => entry.domain), ...list.added])];
}

export const savedNetworkDomainSchema = z.object({ domain: z.string() });
