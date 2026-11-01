import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConnectionType, HealthStatus } from '@ops-console/shared';
import { describe, expect, it } from 'vitest';
import { McpConnectionTester } from '../src/connections/connection-tester';
import { tempDir } from './helpers';

describe('McpConnectionTester', () => {
  it('says why a server that exits at start failed, with the secret hidden', async () => {
    const script = path.join(await tempDir(), 'server.js');
    await writeFile(
      script,
      [
        "console.error('starting');",
        `console.error('Fatal error: password authentication failed for user "reader" (' + process.env.DSN + ')');`,
        "console.error('  routine: auth_failed');",
        'process.exit(1);',
      ].join('\n'),
    );
    const result = await new McpConnectionTester('test').run(ConnectionType.Postgres, {
      target: `${process.execPath} ${script}`,
      env: { DSN: 'postgres://reader:hunter2@db.example.com/orders' },
    });
    expect(result.status).toBe(HealthStatus.Fail);
    expect(result.detail).toBe('Fatal error: password authentication failed for user "reader" (***)');
  });
});
