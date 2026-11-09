/**
 * The hosts the Run sandbox's filter refused, read from what a command printed. The filter answers a refused connection
 * with `deny network-outbound registry.example.com:443 (host is not on the allow list)`, and whatever ran the command
 * (`curl`, `npm`, a test) passes the text on in its output. Each host once, lowercase, in the order first seen. An IP
 * address is left out: the allowlist takes names only.
 */
export function blockedHostsIn(output: unknown): string[] {
  const text = typeof output === 'string' ? output : (JSON.stringify(output) ?? '');
  const hosts = new Set<string>();
  for (const match of text.matchAll(
    /deny network-outbound ([a-z0-9][a-z0-9.-]*\.[a-z][a-z0-9-]*):\d+ \(host is not on the allow list\)/gi,
  )) {
    if (match[1]) hosts.add(match[1].toLowerCase());
  }
  return [...hosts];
}

/** True when a Network allowlist entry (`example.com`, or `*.example.com` for subdomains only) covers `host`. */
export function coveredBy(domains: readonly string[], host: string): boolean {
  return domains.some((domain) =>
    domain.startsWith('*.') ? host.endsWith(domain.slice(1)) && host.length > domain.length - 1 : host === domain,
  );
}
