import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readGoogleClient } from '../src/connectors/google-client';
import { tempDir } from './helpers';

describe('the Google OAuth client of a build', () => {
  it('reads the environment first, then the file packaging wrote, and is null with neither', async () => {
    const file = path.join(await tempDir(), 'google-client.json');
    expect(readGoogleClient({}, file)).toBeNull();

    await writeFile(file, JSON.stringify({ client_id: 'from-file', client_secret: 's-file' }));
    expect(readGoogleClient({}, file)).toEqual({ clientId: 'from-file', clientSecret: 's-file' });
    expect(
      readGoogleClient({ OPS_CONSOLE_GOOGLE_CLIENT_ID: 'from-env', OPS_CONSOLE_GOOGLE_CLIENT_SECRET: 's-env' }, file),
    ).toEqual({ clientId: 'from-env', clientSecret: 's-env' });
    // One half of a pair is no client.
    expect(readGoogleClient({ OPS_CONSOLE_GOOGLE_CLIENT_ID: 'only-id' }, file)).toEqual({
      clientId: 'from-file',
      clientSecret: 's-file',
    });
  });

  it('is null for a file that is not a client', async () => {
    const file = path.join(await tempDir(), 'google-client.json');
    await writeFile(file, '{"client_id":""}');
    expect(readGoogleClient({}, file)).toBeNull();
    await writeFile(file, 'not json');
    expect(readGoogleClient({}, file)).toBeNull();
  });
});
