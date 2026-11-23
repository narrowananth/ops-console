import { ConnectionType, networkDomainSchema } from '@ops-console/shared';

/** The Google hosts a Firebase project's services (Firestore, Realtime Database, Auth, Storage) are reached at. */
const FIREBASE_HOSTS = ['*.googleapis.com', '*.firebaseio.com', '*.firebasedatabase.app'];

/** The hostname in `host`, `host:port` or a URL, or null. A raw IP address or `localhost` is no host the list may hold. */
function hostnameOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const text = raw.trim();
  let host: string;
  try {
    host = new URL(text.includes('://') ? text : `//${text}`, 'http://base.invalid').hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  return networkDomainSchema.safeParse(host).success ? host : null;
}

/**
 * The hosts a saved Connection reaches, read from its config: a database's `host`, a Kafka cluster's bootstrap servers
 * and registry URLs, and the Google hosts of a Firebase project. A MongoDB Connection keeps its host in the Keychain
 * secret, so it adds none. Never an IP address.
 */
export function connectionHosts(type: ConnectionType, config: Record<string, unknown>): string[] {
  const found: (string | null)[] = [];
  switch (type) {
    case ConnectionType.Postgres:
    case ConnectionType.Redis:
    case ConnectionType.Clickhouse:
      found.push(hostnameOf(config.host));
      break;
    case ConnectionType.Kafka:
      if (typeof config.bootstrap_servers === 'string') {
        for (const server of config.bootstrap_servers.split(',')) found.push(hostnameOf(server));
      }
      found.push(hostnameOf(config.schema_registry_url), hostnameOf(config.kafbat_url));
      break;
    case ConnectionType.Firebase:
      return [...FIREBASE_HOSTS];
    case ConnectionType.Mongodb:
      break;
  }
  return [...new Set(found.filter((host): host is string => host !== null))];
}
