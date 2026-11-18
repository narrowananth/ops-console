import { z } from 'zod';

export type GoogleProduct = 'docs' | 'sheets' | 'drive';

/** Where each product's REST API lives. Tests point it at a stand-in for Google. */
export type GoogleHosts = Record<GoogleProduct, string>;

export const GOOGLE_HOSTS: GoogleHosts = {
  docs: 'https://docs.googleapis.com/v1',
  sheets: 'https://sheets.googleapis.com/v4',
  drive: 'https://www.googleapis.com/drive/v3',
};

/** One authorized call to Google; it resolves with the parsed JSON, or the body as text when `text` is set. */
export type GoogleApi = (url: string, init?: { method?: string; body?: unknown; text?: boolean }) => Promise<unknown>;

type Context = { api: GoogleApi; hosts: GoogleHosts };

export type GoogleTool = {
  name: string;
  description: string;
  /** The tool changes nothing in Google. */
  readOnly: boolean;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
  /** Rejects with a message the agent can act on. */
  run(args: unknown, context: Context): Promise<string>;
};

/** Longest file or document text a tool hands the agent, in characters. */
const MAX_TEXT = 100_000;
/** Largest Drive file the console downloads to read, in bytes. */
const MAX_FILE_BYTES = 1_000_000;

function tool<S extends z.ZodObject>(spec: {
  name: string;
  description: string;
  readOnly: boolean;
  schema: S;
  run: (args: z.infer<S>, context: Context) => Promise<string>;
}): GoogleTool {
  const { $schema: _unused, ...inputSchema } = z.toJSONSchema(spec.schema) as Record<string, unknown>;
  return {
    name: spec.name,
    description: spec.description,
    readOnly: spec.readOnly,
    inputSchema,
    run: (args, context) => {
      const parsed = spec.schema.safeParse(args ?? {});
      if (!parsed.success) {
        const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`);
        return Promise.reject(new Error(`Invalid arguments. ${problems.join('; ')}`));
      }
      return spec.run(parsed.data, context);
    },
  };
}

/** The id inside a Docs, Sheets or Drive link; an id given as is stays. */
export function idOf(reference: string): string {
  return /\/(?:d|folders)\/([\w-]+)/.exec(reference)?.[1] ?? /[?&]id=([\w-]+)/.exec(reference)?.[1] ?? reference.trim();
}

const enc = encodeURIComponent;
const clip = (text: string) =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[cut: ${text.length - MAX_TEXT} more characters]` : text;

const reference = (what: string) => z.string().min(1).describe(`${what}: its link or its id`);

// Docs

type Element = {
  paragraph?: { elements?: { textRun?: { content?: string } }[] };
  table?: { tableRows?: { tableCells?: { content?: Element[] }[] }[] };
};
const element: z.ZodType<Element> = z.lazy(() =>
  z.object({
    paragraph: z
      .object({
        elements: z.array(z.object({ textRun: z.object({ content: z.string().optional() }).optional() })).optional(),
      })
      .optional(),
    table: z
      .object({
        tableRows: z
          .array(z.object({ tableCells: z.array(z.object({ content: z.array(element).optional() })).optional() }))
          .optional(),
      })
      .optional(),
  }),
);
const docAnswer = z.object({
  documentId: z.string(),
  title: z.string(),
  body: z.object({ content: z.array(element).optional() }).optional(),
});
const created = z.object({ documentId: z.string().optional(), spreadsheetId: z.string().optional() });

function textOf(content: Element[]): string {
  return content
    .map((part) => {
      if (part.paragraph) return (part.paragraph.elements ?? []).map((run) => run.textRun?.content ?? '').join('');
      const rows = part.table?.tableRows ?? [];
      return rows
        .map((row) => (row.tableCells ?? []).map((cell) => textOf(cell.content ?? []).trim()).join('\t'))
        .join('\n')
        .concat(rows.length > 0 ? '\n' : '');
    })
    .join('');
}

const docUrl = (id: string) => `https://docs.google.com/document/d/${id}/edit`;
const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

const docsTools = (): GoogleTool[] => [
  tool({
    name: 'get_document',
    description: "Reads a Google Doc's title and text.",
    readOnly: true,
    schema: z.object({ document: reference('The Google Doc') }),
    async run({ document }, { api, hosts }) {
      const doc = docAnswer.parse(await api(`${hosts.docs}/documents/${enc(idOf(document))}`));
      return clip(`# ${doc.title}\n\n${textOf(doc.body?.content ?? [])}`);
    },
  }),
  tool({
    name: 'create_document',
    description: 'Creates a Google Doc in the signed-in account, with the text given if any.',
    readOnly: false,
    schema: z.object({ title: z.string().min(1), text: z.string().optional() }),
    async run({ title, text }, { api, hosts }) {
      const made = created.parse(await api(`${hosts.docs}/documents`, { method: 'POST', body: { title } }));
      const id = made.documentId ?? '';
      if (text) {
        await api(`${hosts.docs}/documents/${enc(id)}:batchUpdate`, {
          method: 'POST',
          body: { requests: [{ insertText: { location: { index: 1 }, text } }] },
        });
      }
      return `Created "${title}": ${docUrl(id)}`;
    },
  }),
  tool({
    name: 'append_text',
    description: "Adds text at the end of a Google Doc's body.",
    readOnly: false,
    schema: z.object({ document: reference('The Google Doc'), text: z.string().min(1) }),
    async run({ document, text }, { api, hosts }) {
      const id = idOf(document);
      await api(`${hosts.docs}/documents/${enc(id)}:batchUpdate`, {
        method: 'POST',
        body: { requests: [{ insertText: { endOfSegmentLocation: {}, text } }] },
      });
      return `Added the text to ${docUrl(id)}`;
    },
  }),
  tool({
    name: 'replace_text',
    description: 'Replaces every occurrence of a text in a Google Doc.',
    readOnly: false,
    schema: z.object({
      document: reference('The Google Doc'),
      find: z.string().min(1),
      replace: z.string(),
      match_case: z.boolean().optional().describe('Case must match (default true)'),
    }),
    async run({ document, find, replace, match_case }, { api, hosts }) {
      const id = idOf(document);
      const answer = z
        .object({
          replies: z.array(z.object({ replaceAllText: z.object({ occurrencesChanged: z.number().optional() }) })),
        })
        .parse(
          await api(`${hosts.docs}/documents/${enc(id)}:batchUpdate`, {
            method: 'POST',
            body: {
              requests: [
                {
                  replaceAllText: { containsText: { text: find, matchCase: match_case ?? true }, replaceText: replace },
                },
              ],
            },
          }),
        );
      return `Replaced ${answer.replies[0]?.replaceAllText.occurrencesChanged ?? 0} occurrences in ${docUrl(id)}`;
    },
  }),
];

// Sheets

const sheetsAnswer = z.object({
  properties: z.object({ title: z.string() }),
  sheets: z
    .array(
      z.object({
        properties: z.object({
          title: z.string(),
          gridProperties: z.object({ rowCount: z.number(), columnCount: z.number() }).optional(),
        }),
      }),
    )
    .optional(),
});
const valuesAnswer = z.object({ range: z.string().optional(), values: z.array(z.array(z.unknown())).optional() });
const rows = z
  .array(z.array(z.union([z.string(), z.number(), z.boolean()])))
  .min(1)
  .describe('Rows of cells. A text that starts with "=" is a formula.');
const range = z.string().min(1).describe('A1 notation, such as "Sheet1!A1:C10"');
const spreadsheet = reference('The spreadsheet');

const sheetsTools = (): GoogleTool[] => [
  tool({
    name: 'get_spreadsheet',
    description: "Reads a spreadsheet's title and the name and size of each of its sheets.",
    readOnly: true,
    schema: z.object({ spreadsheet }),
    async run(args, { api, hosts }) {
      const url = `${hosts.sheets}/spreadsheets/${enc(idOf(args.spreadsheet))}?fields=properties.title,sheets.properties(title,gridProperties)`;
      const book = sheetsAnswer.parse(await api(url));
      const lines = (book.sheets ?? []).map(({ properties: sheet }) => {
        const grid = sheet.gridProperties;
        return `- ${sheet.title}${grid ? ` (${grid.rowCount} rows, ${grid.columnCount} columns)` : ''}`;
      });
      return [`# ${book.properties.title}`, ...lines].join('\n');
    },
  }),
  tool({
    name: 'get_values',
    description: 'Reads the cells of a range as rows.',
    readOnly: true,
    schema: z.object({ spreadsheet, range }),
    async run(args, { api, hosts }) {
      const url = `${hosts.sheets}/spreadsheets/${enc(idOf(args.spreadsheet))}/values/${enc(args.range)}`;
      const answer = valuesAnswer.parse(await api(url));
      return clip(`${answer.range ?? args.range}\n${JSON.stringify(answer.values ?? [])}`);
    },
  }),
  tool({
    name: 'update_values',
    description: 'Writes rows into a range, over what is there.',
    readOnly: false,
    schema: z.object({ spreadsheet, range, values: rows }),
    async run(args, { api, hosts }) {
      const id = idOf(args.spreadsheet);
      const url = `${hosts.sheets}/spreadsheets/${enc(id)}/values/${enc(args.range)}?valueInputOption=USER_ENTERED`;
      const answer = z
        .object({ updatedCells: z.number().optional() })
        .parse(await api(url, { method: 'PUT', body: { values: args.values } }));
      return `Updated ${answer.updatedCells ?? 0} cells in ${sheetUrl(id)}`;
    },
  }),
  tool({
    name: 'append_values',
    description: 'Adds rows after the last row of the table that the range falls in.',
    readOnly: false,
    schema: z.object({ spreadsheet, range, values: rows }),
    async run(args, { api, hosts }) {
      const id = idOf(args.spreadsheet);
      const url = `${hosts.sheets}/spreadsheets/${enc(id)}/values/${enc(args.range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
      await api(url, { method: 'POST', body: { values: args.values } });
      return `Added ${args.values.length} rows to ${sheetUrl(id)}`;
    },
  }),
  tool({
    name: 'create_spreadsheet',
    description: 'Creates a spreadsheet in the signed-in account.',
    readOnly: false,
    schema: z.object({ title: z.string().min(1) }),
    async run({ title }, { api, hosts }) {
      const made = created.parse(
        await api(`${hosts.sheets}/spreadsheets`, { method: 'POST', body: { properties: { title } } }),
      );
      return `Created "${title}": ${sheetUrl(made.spreadsheetId ?? '')}`;
    },
  }),
];

// Drive: read-only. The console offers no tool that deletes a file or changes who may open it.

const fileAnswer = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  modifiedTime: z.string().optional(),
  size: z.string().optional(),
  webViewLink: z.string().optional(),
  owners: z.array(z.object({ emailAddress: z.string().optional() })).optional(),
});
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,owners(emailAddress)';
const SHARED = 'supportsAllDrives=true';

/** What Google makes of each of its own file types as text. */
const EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};
const isText = (mime: string) =>
  mime.startsWith('text/') || /(json|xml|yaml|javascript|csv|markdown)/.test(mime.replace(/^application\//, ''));

const describeFile = (file: z.infer<typeof fileAnswer>) =>
  [file.name, file.id, file.mimeType, file.modifiedTime ?? ''].join('\t');

const driveTools = (): GoogleTool[] => [
  tool({
    name: 'search_files',
    description:
      "Lists files in the signed-in account's Drive, newest first, one per line: name, id, type, last change. `query` is Google's Drive search syntax, such as `name contains 'runbook'`, `'<folder id>' in parents` or `mimeType = 'application/vnd.google-apps.spreadsheet'`. Trashed files stay out.",
    readOnly: true,
    schema: z.object({
      query: z.string().optional(),
      page_size: z.number().int().min(1).max(100).optional().describe('How many files, up to 100 (default 25)'),
    }),
    async run({ query, page_size }, { api, hosts }) {
      const q = query?.trim() ? `(${query}) and trashed = false` : 'trashed = false';
      const url = `${hosts.drive}/files?q=${enc(q)}&orderBy=modifiedTime%20desc&pageSize=${page_size ?? 25}&fields=${enc(`files(${FILE_FIELDS})`)}&includeItemsFromAllDrives=true&${SHARED}`;
      const answer = z.object({ files: z.array(fileAnswer).optional() }).parse(await api(url));
      const files = answer.files ?? [];
      return files.length === 0 ? 'No files match.' : files.map(describeFile).join('\n');
    },
  }),
  tool({
    name: 'get_file',
    description: "Reads a file's name, type, size, owners, last change and link.",
    readOnly: true,
    schema: z.object({ file: reference('The file') }),
    async run({ file }, { api, hosts }) {
      const url = `${hosts.drive}/files/${enc(idOf(file))}?fields=${enc(FILE_FIELDS)}&${SHARED}`;
      const meta = fileAnswer.parse(await api(url));
      return [
        `name: ${meta.name}`,
        `id: ${meta.id}`,
        `type: ${meta.mimeType}`,
        `size: ${meta.size ?? 'n/a'}`,
        `modified: ${meta.modifiedTime ?? 'n/a'}`,
        `owners: ${(meta.owners ?? []).map((owner) => owner.emailAddress).join(', ') || 'n/a'}`,
        `link: ${meta.webViewLink ?? 'n/a'}`,
      ].join('\n');
    },
  }),
  tool({
    name: 'read_file',
    description:
      "Reads a file's text: a Google Doc or Slides deck as plain text, a Google Sheet's first sheet as CSV, and a text file as it is. A binary file cannot be read.",
    readOnly: true,
    schema: z.object({ file: reference('The file') }),
    async run({ file }, { api, hosts }) {
      const id = idOf(file);
      const meta = fileAnswer.parse(await api(`${hosts.drive}/files/${enc(id)}?fields=${enc(FILE_FIELDS)}&${SHARED}`));
      const exported = EXPORTS[meta.mimeType];
      if (exported) {
        const text = await api(`${hosts.drive}/files/${enc(id)}/export?mimeType=${enc(exported)}`, { text: true });
        return clip(String(text));
      }
      if (meta.mimeType.startsWith('application/vnd.google-apps.')) {
        throw new Error(`${meta.name} is a ${meta.mimeType} and cannot be read as text`);
      }
      if (!isText(meta.mimeType)) throw new Error(`${meta.name} is a ${meta.mimeType} file, not text`);
      if (Number(meta.size ?? 0) > MAX_FILE_BYTES) throw new Error(`${meta.name} is over ${MAX_FILE_BYTES} bytes`);
      return clip(String(await api(`${hosts.drive}/files/${enc(id)}?alt=media&${SHARED}`, { text: true })));
    },
  }),
];

/** The tools a Google Connector offers the agent. */
export function googleTools(product: GoogleProduct): GoogleTool[] {
  return { docs: docsTools, sheets: sheetsTools, drive: driveTools }[product]();
}
