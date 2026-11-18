import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { GoogleClient } from './connector-tools';

const fileSchema = z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) });

/**
 * The Google OAuth client this build ships: the environment first (`pnpm dev`), else the file packaging wrote from the
 * repo's secrets. `null` when neither holds one, and a Google Connect then says so.
 */
export function readGoogleClient(
  env: { OPS_CONSOLE_GOOGLE_CLIENT_ID?: string; OPS_CONSOLE_GOOGLE_CLIENT_SECRET?: string },
  file: string,
): GoogleClient | null {
  const id = env.OPS_CONSOLE_GOOGLE_CLIENT_ID?.trim();
  const secret = env.OPS_CONSOLE_GOOGLE_CLIENT_SECRET?.trim();
  if (id && secret) return { clientId: id, clientSecret: secret };
  if (!existsSync(file)) return null;
  try {
    const parsed = fileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    return { clientId: parsed.client_id, clientSecret: parsed.client_secret };
  } catch {
    return null;
  }
}
