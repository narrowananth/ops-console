import type { z } from 'zod';

/** The JSON the agent ends its answer with: the last ```json block, or the outermost braces. */
export function parseAgentJson<T extends z.ZodType>(text: string, schema: T): z.infer<T> | null {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const parsed = schema.safeParse(JSON.parse(candidate));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
