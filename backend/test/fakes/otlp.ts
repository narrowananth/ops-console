import { mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

type AnyValue = Record<string, unknown>;
type Attribute = string | number | boolean | AnyValue;

/** One OTLP log record with the resource it came from. Attribute values: a string, integer or boolean, or a raw AnyValue. */
export type OtelRecord = {
  /** Milliseconds since the epoch; the record has no time when null. */
  at: number | null;
  body?: string;
  severity?: number;
  service?: string;
  /** Resource attributes beyond `service.name`, such as `deployment.environment.name`. */
  resource?: Record<string, Attribute>;
  attributes?: Record<string, Attribute>;
};

const anyValue = (value: Attribute): AnyValue => {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return value;
};

const attributeList = (attributes: Record<string, Attribute> = {}) =>
  Object.entries(attributes).map(([key, value]) => ({ key, value: anyValue(value) }));

/** One line of a Collector's file exporter: an `ExportLogsServiceRequest` holding the records. */
export function otlpLine(...records: OtelRecord[]): string {
  return JSON.stringify({
    resourceLogs: records.map((record) => ({
      resource: {
        attributes: attributeList({
          ...(record.service === undefined ? {} : { 'service.name': record.service }),
          ...record.resource,
        }),
      },
      scopeLogs: [
        {
          scope: { name: 'orders' },
          logRecords: [
            {
              ...(record.at === null ? {} : { timeUnixNano: String(BigInt(record.at) * 1_000_000n) }),
              ...(record.severity === undefined ? {} : { severityNumber: record.severity }),
              ...(record.body === undefined ? {} : { body: { stringValue: record.body } }),
              attributes: attributeList(record.attributes),
            },
          ],
        },
      ],
    })),
  });
}

/** Writes `lines` to `name` in `folder`; `modified` (ms since the epoch) sets the file's time, which orders the files. */
export async function writeLogFile(folder: string, name: string, lines: string[], modified?: number): Promise<string> {
  const file = path.join(folder, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${lines.join('\n')}\n`);
  if (modified !== undefined) await utimes(file, new Date(modified), new Date(modified));
  return file;
}
