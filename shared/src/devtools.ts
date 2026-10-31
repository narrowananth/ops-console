import { z } from 'zod';
import { AccessMode, Effort, Model, SessionKind } from './agents';

/** `POST /sessions` for the `devtools` kind. An empty or missing scope means every Connection with access. */
export const createDevtoolsSessionSchema = z.strictObject({
  kind: z.literal(SessionKind.Devtools),
  connection_ids: z.array(z.string().min(1)).default([]),
  model: z.enum(Model).optional(),
  effort: z.enum(Effort).optional(),
  access_mode: z.enum(AccessMode).optional(),
});

export type CreateDevtoolsSession = z.infer<typeof createDevtoolsSessionSchema>;
