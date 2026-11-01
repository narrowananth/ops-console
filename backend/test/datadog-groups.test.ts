import type { Sample } from '@ops-console/shared';
import { describe, expect, it } from 'vitest';
import { groupLogs, repoUrlOf } from '../src/monitor/datadog';

const log = (
  minute: number,
  message: string,
  attributes: Record<string, unknown> = {},
  tags: string[] = [],
): Sample => ({
  id: `log-${minute}-${message.length}`,
  timestamp: new Date(Date.UTC(2026, 9, 1, 12, 59 - minute)).toISOString(),
  status: 'error',
  message,
  attributes,
  tags,
});

const http = (method: string, path: string) => ({ http: { method, url_details: { path } } });

describe('log groups', () => {
  it('groups logs by Route and masked message, newest first', () => {
    const logs = [
      log(0, 'order 1042 not found', http('get', '/orders/1042')),
      log(1, 'order 77 not found', http('GET', '/orders/77')),
      log(2, 'timeout after 3000 ms'),
      log(3, 'timeout after 2500 ms'),
      log(4, 'timeout after 2500 ms', http('POST', '/orders')),
    ];
    const groups = groupLogs(logs, 'env:prod service:orders-api');
    expect(groups.map((group) => [group.method, group.path, group.errors])).toEqual([
      ['GET', '/orders/:id', 2],
      ['', '', 2],
      ['POST', '/orders', 1],
    ]);
    expect(groups[0]?.samples.map((sample) => sample.message)).toEqual(['order 1042 not found', 'order 77 not found']);
    expect(groups[0]?.query).toBe('env:prod service:orders-api @http.method:GET @http.url_details.path:/orders/*');
    expect(groups[1]?.query).toBe('env:prod service:orders-api');
  });

  it('splits a Route by HTTP status code, read as a number or a string', () => {
    const coded = (code: unknown) => ({ http: { method: 'GET', url_details: { path: '/me' }, status_code: code } });
    const logs = [log(0, 'denied', coded(401)), log(1, 'denied', coded('401')), log(2, 'denied', coded(500))];
    const groups = groupLogs(logs, 'service:apis');
    expect(groups.map((group) => [group.statusCode, group.errors])).toEqual([
      [401, 2],
      [500, 1],
    ]);
    expect(groups[0]?.query).toBe('service:apis @http.status_code:401 @http.method:GET @http.url_details.path:/me');
  });

  it('counts the worst 10-minute bucket and keeps 25 Samples', () => {
    const logs = Array.from({ length: 40 }, (_, minute) => log(minute, 'boom'));
    const [group] = groupLogs(logs, 'q');
    expect(group?.errors).toBe(40);
    expect(group?.peakPer10m).toBe(10);
    expect(group?.samples).toHaveLength(25);
  });

  it('reads the Git URL from the source code tag', () => {
    expect(repoUrlOf([log(0, 'a'), log(1, 'b', {}, ['env:prod', 'git.repository_url:github.com/acme/orders'])])).toBe(
      'github.com/acme/orders',
    );
    expect(repoUrlOf([log(0, 'a')])).toBeNull();
  });
});
