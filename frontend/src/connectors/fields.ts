import { ConnectorId } from '@ops-console/shared';

export type Field = {
  /** Dotted path into the config. */
  key: string;
  label: string;
  kind: 'text' | 'number' | 'list' | 'bool' | 'pairs' | 'ignore';
  options?: string[];
};

/** What the drawer edits for each Connector, in the order shown. */
export const FIELDS: Record<ConnectorId, Field[]> = {
  [ConnectorId.Datadog]: [
    { key: 'site', label: 'Datadog site', kind: 'text' },
    { key: 'environments', label: 'Environments (comma separated)', kind: 'list' },
    { key: 'daily_scan_time', label: 'Daily scan time (HH:MM)', kind: 'text' },
    { key: 'default_interval', label: 'Default interval', kind: 'text', options: ['24h', '12h', '6h'] },
    { key: 'rapid_errors_per_10m', label: 'Rapid errors per 10 minutes', kind: 'number' },
    { key: 'failing_errors_per_hour', label: 'Failing errors per hour', kind: 'number' },
    { key: 'ignore', label: 'Ignore (one per line, status_class:5xx or route:/health)', kind: 'ignore' },
    { key: 'reports_folder', label: 'Reports folder', kind: 'text' },
  ],
  [ConnectorId.Jira]: [
    { key: 'site', label: 'Jira site', kind: 'text' },
    { key: 'project_key', label: 'Project key', kind: 'text' },
    { key: 'issue_types.bug', label: 'Bug issue type', kind: 'text' },
    { key: 'issue_types.improvement', label: 'Improvement issue type', kind: 'text' },
    { key: 'in_review_status', label: 'In review status', kind: 'text' },
    { key: 'create_tickets', label: 'Create tickets for confirmed Reports', kind: 'bool' },
  ],
  [ConnectorId.Github]: [{ key: 'org', label: 'Organization (optional)', kind: 'text' }],
  [ConnectorId.Gitlab]: [{ key: 'host', label: 'GitLab host', kind: 'text' }],
  [ConnectorId.Bitbucket]: [
    { key: 'workspace', label: 'Workspace', kind: 'text' },
    { key: 'ssh_key_path', label: 'SSH key path', kind: 'text' },
    { key: 'pr_target_branch', label: 'Pull request target branch', kind: 'text' },
  ],
  [ConnectorId.Slack]: [
    { key: 'workspace', label: 'Workspace', kind: 'text' },
    { key: 'alert_channel', label: 'Alert channel', kind: 'text' },
    { key: 'review_dm_to', label: 'Send review requests to', kind: 'text' },
  ],
  [ConnectorId.Sentry]: [{ key: 'org', label: 'Organization (optional)', kind: 'text' }],
};

export function read(config: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], config);
}

/** Builds the PATCH body from the edited drafts. A field left blank is left out so the stored value stays. */
export function toPatch(drafts: Record<string, string | boolean>, fields: Field[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of fields) {
    const draft = drafts[field.key];
    if (draft === undefined) continue;
    let value: unknown;
    if (field.kind === 'bool') value = draft;
    else if (typeof draft === 'string' && draft.trim() === '') continue;
    else if (field.kind === 'number') value = Number(draft);
    else if (field.kind === 'list')
      value = String(draft)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    else if (field.kind === 'ignore') {
      value = String(draft)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [kind, ...rest] = line.split(':');
          return { kind: kind?.trim(), value: rest.join(':').trim() };
        });
    } else value = draft;
    const path = field.key.split('.');
    let at = patch;
    for (const part of path.slice(0, -1)) {
      at[part] ??= {};
      at = at[part] as Record<string, unknown>;
    }
    at[path.at(-1) as string] = value;
  }
  return patch;
}
