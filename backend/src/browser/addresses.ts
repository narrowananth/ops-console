import { CONSOLE_PORTS } from '@ops-console/shared';

export const isConsolePort = (port: number): boolean => (CONSOLE_PORTS as readonly number[]).includes(port);

const LOOPBACK = new Set(['localhost', '[::1]', '::1']);

export const isLoopbackHost = (host: string): boolean => {
  const name = host.toLowerCase();
  return LOOPBACK.has(name) || name.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(name);
};

/**
 * Reads what the operator typed: a URL, `host:port`, or a bare port. Returns null for a scheme other than http or https,
 * or when nothing parses.
 */
export function normalizeAddress(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  if (/^\d{1,5}$/.test(text)) return Number(text) >= 1 && Number(text) <= 65535 ? `http://localhost:${text}/` : null;
  const withScheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]?.toLowerCase();
  let candidate = text;
  if (withScheme) {
    if (withScheme !== 'http' && withScheme !== 'https') return null;
  } else {
    // `localhost:5173` looks like a scheme to the URL parser; `javascript:x` and `mailto:x` are real ones.
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+([/?#]|$)/.test(text)) return null;
    const host = /^\[[^\]]*\]/.exec(text)?.[0] ?? text.split(/[:/?#]/, 1)[0] ?? '';
    candidate = `${isLoopbackHost(host) ? 'http' : 'https'}://${text}`;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The agent's reach: a loopback host, and not one of the console's own ports. */
export function agentMayOpen(address: string): boolean {
  try {
    const url = new URL(address);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!isLoopbackHost(url.hostname)) return false;
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return !isConsolePort(port);
  } catch {
    return false;
  }
}
