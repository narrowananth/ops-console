import type { Message, Part } from '@ops-console/shared';
import { z } from 'zod';
import { mcpTool } from '../action-log/classify';
import { redact } from '../action-log/redact';

const blockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.string() }),
]);

export type ContentBlock = z.infer<typeof blockSchema>;

export const contentSchema = z.union([z.string(), z.array(blockSchema)]);

/** One entry from `getSessionMessages`. `timestamp`, `is_meta` and `isCompactSummary` are not in the SDK's type. */
const entrySchema = z.object({
  type: z.enum(['user', 'assistant', 'system']),
  uuid: z.string(),
  message: z.object({ content: contentSchema }).loose(),
  parent_tool_use_id: z.string().nullable(),
  timestamp: z.string().optional(),
  is_meta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
});

export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export const questionInputSchema = z.object({
  questions: z.array(z.object({ question: z.string(), options: z.array(z.object({ label: z.string() })) })),
});

/** Splits ``` fences out of agent text into `code` parts. */
function textParts(text: string): Part[] {
  const parts: Part[] = [];
  const fence = /```([\w+-]*)[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  for (let match = fence.exec(text); match !== null; match = fence.exec(text)) {
    const before = text.slice(last, match.index).trim();
    if (before) parts.push({ kind: 'text', text: before });
    parts.push({ kind: 'code', lang: match[1] ?? '', text: (match[2] ?? '').replace(/\n$/, '') });
    last = match.index + match[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest) parts.push({ kind: 'text', text: rest });
  return parts;
}

const lines = (text: unknown, sign: '+' | '-') =>
  typeof text === 'string' && text ? text.split('\n').map((line) => ({ sign, text: line })) : [];

/** What a step calls an MCP server: by default its name; a kind may add the Connection's Access Level. */
export type ServerLabel = (server: string) => string | null;

export function stepText(name: string, input: Record<string, unknown>, label?: ServerLabel | null): string {
  if (name === 'Bash') return `$ ${redact(String(input.command ?? ''))}`;
  const mcp = mcpTool(name);
  if (mcp) return `${label?.(mcp.server) ?? mcp.server}: ${mcp.tool}`;
  const subject = input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description;
  return typeof subject === 'string' ? `${name} ${subject}` : name;
}

function toolParts(name: string, input: Record<string, unknown>, label?: ServerLabel | null): Part[] {
  if (name === 'AskUserQuestion') {
    const parsed = questionInputSchema.safeParse(input);
    if (parsed.success) {
      return parsed.data.questions.map((question) => ({
        kind: 'question',
        text: question.question,
        options: question.options.map((option) => option.label),
      }));
    }
  }
  const file = typeof input.file_path === 'string' ? input.file_path : null;
  if (file && (name === 'Edit' || name === 'MultiEdit' || name === 'Write')) {
    const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input];
    const diff =
      name === 'Write'
        ? lines(input.content, '+')
        : edits.flatMap((edit) => [...lines(edit.old_string, '-'), ...lines(edit.new_string, '+')]);
    return [{ kind: 'diff', file, lines: diff }];
  }
  return [{ kind: 'step', text: stepText(name, input, label) }];
}

/** Parts for one assistant content block: text, tool calls, file edits, code blocks and questions. */
export function blockParts(block: ContentBlock, label?: ServerLabel | null): Part[] {
  if (block.type === 'text' && 'text' in block) return textParts(block.text);
  if (block.type === 'tool_use' && 'name' in block) return toolParts(block.name, block.input, label);
  return [];
}

/** Prompts the operator typed; not tool results, compaction summaries or slash-command echoes. */
function operatorText(entry: z.infer<typeof entrySchema>): string | null {
  if (entry.is_meta || entry.isCompactSummary) return null;
  const { content } = entry.message;
  const text =
    typeof content === 'string'
      ? content
      : content.flatMap((block) => (block.type === 'text' && 'text' in block ? [block.text] : [])).join('\n');
  if (!text.trim() || /^\s*<(command-|local-command-)/.test(text)) return null;
  return text;
}

/**
 * Maps transcript entries to `Message`s, oldest first. Each operator prompt is one user message; the assistant
 * entries after it, with their tool calls, are one agent message. Subagent entries and the uuids in `skip` (the
 * run in progress, served from memory) are left out.
 */
export function toMessages(
  raw: unknown[],
  skip: ReadonlySet<string> = new Set(),
  label?: ServerLabel | null,
): Message[] {
  const messages: Message[] = [];
  for (const value of raw) {
    const parsed = entrySchema.safeParse(value);
    if (!parsed.success) continue;
    const entry = parsed.data;
    if (entry.parent_tool_use_id !== null || entry.type === 'system' || skip.has(entry.uuid)) continue;
    const createdAt = entry.timestamp ?? new Date(0).toISOString();
    if (entry.type === 'user') {
      const text = operatorText(entry);
      if (text !== null) {
        messages.push({
          id: entry.uuid,
          role: 'user',
          status: 'done',
          parts: [{ kind: 'text', text }],
          created_at: createdAt,
        });
      }
      continue;
    }
    const content = entry.message.content;
    const parts =
      typeof content === 'string' ? textParts(content) : content.flatMap((block) => blockParts(block, label));
    const last = messages.at(-1);
    if (last?.role === 'agent') last.parts.push(...parts);
    else messages.push({ id: entry.uuid, role: 'agent', status: 'done', parts, created_at: createdAt });
  }
  return messages;
}
