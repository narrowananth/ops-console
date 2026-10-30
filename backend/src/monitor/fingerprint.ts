import { createHash } from 'node:crypto';

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi;
const TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const HEX_ID = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi;
const NUMBER = /\b\d+(?:\.\d+)?\b/g;
const OBJECT_ID = /\b[0-9a-f]{24}\b/gi;

/** An error message with ids, numbers, timestamps and addresses masked, so repeats of one failure read the same. */
export function maskSignature(message: string): string {
  return message
    .replace(TIMESTAMP, '<time>')
    .replace(UUID, '<id>')
    .replace(IPV4, '<ip>')
    .replace(IPV6, '<ip>')
    .replace(OBJECT_ID, '<id>')
    .replace(HEX_ID, '<id>')
    .replace(NUMBER, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** `/orders/1042/items/9f3a…` becomes `/orders/:id/items/:id`, so one Route is not one row per id. */
export function normalizePath(path: string): string {
  const clean = path.split('?')[0] ?? path;
  return clean
    .split('/')
    .map((segment) =>
      /^\d+$/.test(segment) || (/^[0-9a-f-]{8,}$/i.test(segment) && /\d/.test(segment)) ? ':id' : segment,
    )
    .join('/');
}

/** The identity of an Alert: Service, Route and the error signature (Glossary: Fingerprint). */
export function fingerprint(serviceId: string, method: string, path: string, message: string): string {
  return createHash('sha256')
    .update([serviceId, method.toUpperCase(), path, maskSignature(message)].join('\n'))
    .digest('hex')
    .slice(0, 32);
}
