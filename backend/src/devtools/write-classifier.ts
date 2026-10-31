import { ConnectionType } from '@ops-console/shared';

const SQL_WRITE =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|vacuum|reindex|into|pg_terminate_backend|pg_cancel_backend)\b/i;
const SQL_READ_START = /^(select|show|explain|describe|desc|values|table|with)\b/i;

/** Whether every statement only reads. Anything it cannot place counts as a write. */
export function sqlReads(sql: string): boolean {
  const bare = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
  const statements = bare
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
  return statements.length > 0 && statements.every((s) => SQL_READ_START.test(s) && !SQL_WRITE.test(s));
}

const text = (input: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys) if (typeof input[key] === 'string') return input[key];
  return '';
};

/** Tools that only read, per MCP server. A tool not listed is a write: a new tool asks before it is trusted. */
const READ_TOOLS: Partial<Record<ConnectionType, ReadonlySet<string>>> = {
  [ConnectionType.Postgres]: new Set(['search_objects']),
  [ConnectionType.Clickhouse]: new Set(['list_databases', 'list_tables']),
  [ConnectionType.Mongodb]: new Set([
    'find',
    'count',
    'collection-indexes',
    'collection-schema',
    'collection-storage-size',
    'db-stats',
    'explain',
    'export',
    'list-collections',
    'list-databases',
    'list-connections',
    'list-knowledge-sources',
    'search-knowledge',
    'mongodb-logs',
    'connect',
    'disconnect',
    'atlas-local-list-deployments',
  ]),
  [ConnectionType.Redis]: new Set([
    'get',
    'hget',
    'hgetall',
    'hexists',
    'lrange',
    'llen',
    'smembers',
    'zrange',
    'type',
    'scan_keys',
    'scan_all_keys',
    'dbsize',
    'info',
    'client_list',
    'get_indexes',
    'get_index_info',
    'get_indexed_keys_number',
    'get_vector_from_hash',
    'hybrid_search',
    'vector_search_hash',
    'search_redis_documents',
    'json_get',
    'xrange',
    'read_messages',
    'subscribe',
    'psubscribe',
    'unsubscribe',
  ]),
};

/** Whether an MCP tool call on a Connection of this type writes. */
export function isWrite(type: ConnectionType, tool: string, input: Record<string, unknown>): boolean {
  if (type === ConnectionType.Postgres && tool === 'execute_sql') return !sqlReads(text(input, 'sql', 'query'));
  if (type === ConnectionType.Clickhouse && tool === 'run_query') return !sqlReads(text(input, 'query', 'sql'));
  if (type === ConnectionType.Mongodb && tool === 'aggregate') return /"\$(out|merge)"/.test(JSON.stringify(input));
  return !READ_TOOLS[type]?.has(tool);
}
