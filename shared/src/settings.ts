import { z } from 'zod';

export const settingsPatchSchema = z
  .record(z.string(), z.unknown())
  .refine((body) => Object.keys(body).length > 0, 'at least one key');

export type Settings = Record<string, unknown>;
