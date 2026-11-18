import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { LoopbackGoogleAuth } from '../src/connectors/google-auth';
import { runGoogleBridge } from '../src/mcp/google-bridge';
import { FakeGoogle } from './fakes/google';

const open: FakeGoogle[] = [];
afterEach(async () => {
  for (const google of open.splice(0)) await google.close();
});

/** Signs in on the fake Google and returns the env the console's launcher would hand the bridge. */
async function signedIn() {
  const google = await FakeGoogle.start();
  open.push(google);
  const auth = new LoopbackGoogleAuth(google.client, google.endpoints);
  const { refreshToken } = await auth.signIn(['openid'], new AbortController().signal, (url) => void google.visit(url));
  const env = {
    GOOGLE_CLIENT_ID: google.client.clientId,
    GOOGLE_CLIENT_SECRET: google.client.clientSecret,
    GOOGLE_REFRESH_TOKEN: refreshToken,
  };
  return { google, env };
}

type Reply = {
  id: number;
  result?: {
    tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[];
    serverInfo?: { name: string };
    protocolVersion?: string;
    content?: { text: string }[];
    isError?: boolean;
  };
  error?: { message: string };
};

/** Starts the bridge as Claude Code would, and talks to it by method and params. */
function session(product: string, google: FakeGoogle, env: Record<string, string>) {
  const input = new PassThrough();
  const output = new PassThrough();
  const log = new PassThrough();
  const waiting = new Map<number, (reply: Reply) => void>();
  let buffer = '';
  let next = 0;
  output.on('data', (chunk) => {
    buffer += String(chunk);
    const rows = buffer.split('\n');
    buffer = rows.pop() ?? '';
    for (const row of rows.filter(Boolean)) {
      const reply = JSON.parse(row) as Reply;
      waiting.get(reply.id)?.(reply);
    }
  });
  const done = runGoogleBridge(product, env, input, output, log, {
    token: google.endpoints.token,
    hosts: google.hosts,
  });
  const ask = (method: string, params?: object) =>
    new Promise<Reply>((resolve) => {
      next += 1;
      waiting.set(next, resolve);
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`);
    });
  return {
    ask,
    /** A tool call: the text the agent reads, and whether it is an error. */
    async call(name: string, args: object) {
      const reply = await ask('tools/call', { name, arguments: args });
      return { text: reply.result?.content?.[0]?.text ?? '', isError: reply.result?.isError === true, reply };
    },
    async end() {
      input.end();
      const code = await done;
      return { code, log: String(log.read() ?? '') };
    },
  };
}

const refreshes = (google: FakeGoogle) => google.tokenCalls.filter((call) => call.grant_type === 'refresh_token');

describe('the Google bridge', () => {
  it("answers Claude Code's handshake and lists the product's tools, marking the ones that only read", async () => {
    const { google, env } = await signedIn();
    const bridge = session('docs', google, env);
    const hello = await bridge.ask('initialize', { protocolVersion: '2025-06-18' });
    const tools = await bridge.ask('tools/list');
    await bridge.end();

    expect(hello.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'google-docs' } });
    const listed = tools.result?.tools ?? [];
    expect(listed.map((tool) => [tool.name, tool.annotations?.readOnlyHint])).toEqual([
      ['get_document', true],
      ['create_document', false],
      ['append_text', false],
      ['replace_text', false],
    ]);
    // Listing needs no token.
    expect(refreshes(google)).toHaveLength(0);
  });

  it('reads a Doc from its link as text, with one minted token for every call', async () => {
    const { google, env } = await signedIn();
    google.answer('GET', '/docs/documents/doc-1', {
      documentId: 'doc-1',
      title: 'Runbook',
      body: {
        content: [
          { paragraph: { elements: [{ textRun: { content: 'Restart the worker.\n' } }] } },
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    { content: [{ paragraph: { elements: [{ textRun: { content: 'a\n' } }] } }] },
                    { content: [{ paragraph: { elements: [{ textRun: { content: 'b\n' } }] } }] },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    const bridge = session('docs', google, env);
    const first = await bridge.call('get_document', {
      document: 'https://docs.google.com/document/d/doc-1/edit?tab=t.0',
    });
    const second = await bridge.call('get_document', { document: 'doc-1' });
    await bridge.end();

    expect(first).toMatchObject({ isError: false, text: '# Runbook\n\nRestart the worker.\na\tb\n' });
    expect(second.text).toBe(first.text);
    expect(new Set(google.apiCalls.map((call) => call.auth)).size).toBe(1);
    expect(google.apiCalls.every((call) => call.auth?.startsWith('Bearer access-'))).toBe(true);
    expect(refreshes(google)).toHaveLength(1);
  });

  it('shares one token request between calls that arrive together', async () => {
    const { google, env } = await signedIn();
    google.answer('GET', '/sheets/spreadsheets/book/values/A1', { range: 'A1', values: [['x']] });
    const bridge = session('sheets', google, env);
    await Promise.all([1, 2, 3].map(() => bridge.call('get_values', { spreadsheet: 'book', range: 'A1' })));
    await bridge.end();
    expect(refreshes(google)).toHaveLength(1);
  });

  it('mints a new token and tries the call again once when Google stops taking the old one', async () => {
    const { google, env } = await signedIn();
    google.answer('GET', '/sheets/spreadsheets/book/values/A1', { range: 'A1', values: [['x']] });
    const bridge = session('sheets', google, env);
    await bridge.call('get_values', { spreadsheet: 'book', range: 'A1' });
    google.expireAccessTokens();
    const again = await bridge.call('get_values', { spreadsheet: 'book', range: 'A1' });
    await bridge.end();
    expect(again.isError).toBe(false);
    expect(refreshes(google)).toHaveLength(2);
  });

  it('writes cells as typed, and a range with a sheet name reaches Google whole', async () => {
    const { google, env } = await signedIn();
    google.answer('PUT', '/sheets/spreadsheets/book/values/Sheet1!A1:B2', { updatedCells: 4 });
    google.answer('POST', '/sheets/spreadsheets/book/values/Sheet1!A1:append', {});
    const bridge = session('sheets', google, env);
    const written = await bridge.call('update_values', {
      spreadsheet: 'https://docs.google.com/spreadsheets/d/book/edit#gid=0',
      range: 'Sheet1!A1:B2',
      values: [
        ['name', 'total'],
        ['x', '=SUM(1,2)'],
      ],
    });
    await bridge.call('append_values', { spreadsheet: 'book', range: 'Sheet1!A1', values: [['y', 3]] });
    await bridge.end();

    expect(written.text).toContain('Updated 4 cells');
    const [put, append] = google.apiCalls;
    expect(put?.query.get('valueInputOption')).toBe('USER_ENTERED');
    expect(put?.body).toEqual({
      values: [
        ['name', 'total'],
        ['x', '=SUM(1,2)'],
      ],
    });
    expect(append?.query.get('insertDataOption')).toBe('INSERT_ROWS');
  });

  it('edits a Doc in place: appends at the end and replaces text', async () => {
    const { google, env } = await signedIn();
    google.answer('POST', '/docs/documents/doc-1:batchUpdate', {
      replies: [{ replaceAllText: { occurrencesChanged: 3 } }],
    });
    const bridge = session('docs', google, env);
    await bridge.call('append_text', { document: 'doc-1', text: 'Done.' });
    const replaced = await bridge.call('replace_text', { document: 'doc-1', find: 'old', replace: 'new' });
    await bridge.end();

    expect(google.apiCalls[0]?.body).toEqual({
      requests: [{ insertText: { endOfSegmentLocation: {}, text: 'Done.' } }],
    });
    expect(replaced.text).toContain('Replaced 3 occurrences');
    expect(google.apiCalls[1]?.body).toMatchObject({
      requests: [{ replaceAllText: { containsText: { text: 'old', matchCase: true }, replaceText: 'new' } }],
    });
  });

  it('reads Drive only: files are searched and read, and no tool deletes a file or shares it', async () => {
    const { google, env } = await signedIn();
    const meta = (id: string, name: string, mimeType: string, size?: string) =>
      google.answer('GET', `/drive/files/${id}`, { id, name, mimeType, ...(size ? { size } : {}) });
    google.answer('GET', '/drive/files', {
      files: [
        {
          id: 'f1',
          name: 'Plan',
          mimeType: 'application/vnd.google-apps.document',
          modifiedTime: '2026-11-01T00:00:00Z',
        },
      ],
    });
    meta('f1', 'Plan', 'application/vnd.google-apps.document');
    google.answer('GET', '/drive/files/f1/export', 'the plan text');
    const bridge = session('drive', google, env);

    const listed = await bridge.ask('tools/list');
    expect(listed.result?.tools?.map((tool) => tool.name)).toEqual(['search_files', 'get_file', 'read_file']);
    expect(listed.result?.tools?.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);

    const found = await bridge.call('search_files', { query: "name contains 'Plan'" });
    const read = await bridge.call('read_file', { file: 'https://drive.google.com/file/d/f1/view' });
    await bridge.end();

    expect(found.text).toBe('Plan\tf1\tapplication/vnd.google-apps.document\t2026-11-01T00:00:00Z');
    expect(google.apiCalls[0]?.query.get('q')).toBe("(name contains 'Plan') and trashed = false");
    expect(read.text).toBe('the plan text');
    expect(google.apiCalls.at(-1)?.query.get('mimeType')).toBe('text/plain');
  });

  it('reads a Sheet as CSV, a text file as it is, and refuses a binary file', async () => {
    const { google, env } = await signedIn();
    const meta = (id: string, mimeType: string) =>
      google.answer('GET', `/drive/files/${id}`, { id, name: id, mimeType });
    meta('sheet', 'application/vnd.google-apps.spreadsheet');
    google.answer('GET', '/drive/files/sheet/export', 'a,b\n1,2\n');
    meta('note', 'text/markdown');
    google.answer('GET', '/drive/files/note?alt=media', '# hello');
    meta('pic', 'image/png');
    const bridge = session('drive', google, env);
    const sheet = await bridge.call('read_file', { file: 'sheet' });
    expect(sheet.text).toBe('a,b\n1,2\n');
    expect(google.apiCalls.at(-1)?.query.get('mimeType')).toBe('text/csv');
    expect((await bridge.call('read_file', { file: 'note' })).text).toBe('# hello');
    const picture = await bridge.call('read_file', { file: 'pic' });
    await bridge.end();
    expect(picture).toMatchObject({ isError: true });
    expect(picture.text).toContain('not text');
  });

  it("gives the agent Google's own refusal as the tool's result, and bad arguments as one too", async () => {
    const { google, env } = await signedIn();
    google.answer('GET', '/docs/documents/secret', { error: { message: 'The caller does not have permission' } }, 403);
    const bridge = session('docs', google, env);
    const refused = await bridge.call('get_document', { document: 'secret' });
    const invalid = await bridge.call('get_document', {});
    const unknown = await bridge.ask('tools/call', { name: 'trash_file', arguments: {} });
    await bridge.end();

    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain('Google answered 403');
    expect(refused.text).toContain('does not have permission');
    expect(invalid).toMatchObject({ isError: true });
    expect(invalid.text).toContain('document');
    expect(unknown.error?.message).toContain('Unknown tool');
  });

  it('answers a call with an error that names the sign-in, never the token, when Google refuses it for good', async () => {
    const { google, env } = await signedIn();
    google.revoke(env.GOOGLE_REFRESH_TOKEN);
    const bridge = session('docs', google, env);
    const answer = await bridge.call('get_document', { document: 'doc-1' });
    const { code, log } = await bridge.end();
    expect(code).toBe(0);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('Connect the Connector again');
    expect(JSON.stringify(answer.reply) + log).not.toContain(env.GOOGLE_REFRESH_TOKEN);
  });

  it("refuses to start without the console's sign-in or for a product it does not know", async () => {
    const { google, env } = await signedIn();
    const signedOut = await session('docs', google, {}).end();
    expect(signedOut.code).toBe(2);
    expect(signedOut.log).toContain('Connect the Connector again');
    const unknown = await session('calendar', google, env).end();
    expect(unknown.code).toBe(2);
    expect(unknown.log).toContain('docs, sheets, drive');
  });
});
