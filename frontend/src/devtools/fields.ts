import { ConnectionType } from '@ops-console/shared';

export type Field = { key: string; label: string; kind: 'text' | 'number' | 'list'; placeholder?: string };

export const TYPE_LABELS: Record<ConnectionType, string> = {
  [ConnectionType.Postgres]: 'Postgres',
  [ConnectionType.Mongodb]: 'MongoDB',
  [ConnectionType.Redis]: 'Redis',
  [ConnectionType.Clickhouse]: 'ClickHouse',
  [ConnectionType.Firebase]: 'Firebase',
  [ConnectionType.Kafka]: 'Kafka',
};

export const SECRET_LABELS: Record<ConnectionType, { label: string; optional: boolean; multiline?: boolean }> = {
  [ConnectionType.Postgres]: { label: 'Password', optional: false },
  [ConnectionType.Mongodb]: { label: 'Connection string', optional: false },
  [ConnectionType.Redis]: { label: 'Password', optional: true },
  [ConnectionType.Clickhouse]: { label: 'Password', optional: true },
  [ConnectionType.Firebase]: { label: 'Service account JSON', optional: false, multiline: true },
  [ConnectionType.Kafka]: { label: 'SASL password', optional: true },
};

export const FIELDS: Record<ConnectionType, Field[]> = {
  [ConnectionType.Postgres]: [
    { key: 'host', label: 'Host', kind: 'text', placeholder: 'db.example.com' },
    { key: 'port', label: 'Port', kind: 'number', placeholder: '5432' },
    { key: 'database', label: 'Database', kind: 'text' },
    { key: 'user', label: 'User', kind: 'text' },
  ],
  [ConnectionType.Mongodb]: [{ key: 'database', label: 'Database (optional)', kind: 'text' }],
  [ConnectionType.Redis]: [
    { key: 'host', label: 'Host', kind: 'text' },
    { key: 'port', label: 'Port', kind: 'number', placeholder: '6379' },
    { key: 'db_index', label: 'DB index', kind: 'number', placeholder: '0' },
  ],
  [ConnectionType.Clickhouse]: [
    { key: 'host', label: 'Host', kind: 'text' },
    { key: 'http_port', label: 'HTTP port', kind: 'number', placeholder: '8123' },
    { key: 'database', label: 'Database', kind: 'text', placeholder: 'default' },
    { key: 'user', label: 'User', kind: 'text', placeholder: 'default' },
  ],
  [ConnectionType.Firebase]: [
    { key: 'project_id', label: 'Project id', kind: 'text' },
    { key: 'services', label: 'Services (comma separated)', kind: 'list' },
  ],
  [ConnectionType.Kafka]: [
    { key: 'bootstrap_servers', label: 'Bootstrap servers', kind: 'text' },
    { key: 'sasl_mechanism', label: 'SASL mechanism', kind: 'text' },
    { key: 'schema_registry_url', label: 'Schema registry URL', kind: 'text' },
    { key: 'kafbat_url', label: 'Kafbat URL', kind: 'text' },
  ],
};

/** The config body from the form drafts: numbers as numbers, lists split, blanks dropped. */
export function toConfig(type: ConnectionType, drafts: Record<string, string>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of FIELDS[type]) {
    const draft = (drafts[field.key] ?? '').trim();
    if (draft === '') continue;
    config[field.key] =
      field.kind === 'number'
        ? Number(draft)
        : field.kind === 'list'
          ? draft
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean)
          : draft;
  }
  return config;
}

export function hostOf(config: Record<string, unknown>): string {
  const host = config.host ?? config.project_id ?? config.bootstrap_servers ?? '';
  return String(host) + (config.port ? `:${String(config.port)}` : '');
}
