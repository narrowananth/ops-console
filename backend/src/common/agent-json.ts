import type { z } from 'zod';

/**
 * The JSON the agent ends its answer with: the last ```json block, or the outermost braces. A string in the JSON may
 * hold its own fenced block (a Report's markdown), so the block runs to the last closing brace when the first fence
 * after it cuts the JSON short.
 */
export function parseAgentJson<T extends z.ZodType>(text: string, schema: T): z.infer<T> | null {
  // The last opening first; a markdown string that holds a ```json block of its own needs an earlier one.
  const blocks = [...text.matchAll(/```json/g)].reverse().map((match) => text.slice(match.index + match[0].length));
  const candidates = [
    ...blocks.flatMap((block) => [
      block.match(/^\s*([\s\S]*?)```/)?.[1],
      block.slice(block.indexOf('{'), block.lastIndexOf('}') + 1),
    ]),
    text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = schema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // The next, wider candidate may parse.
    }
  }
  return null;
}
