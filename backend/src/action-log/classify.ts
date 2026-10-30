import { ActionKind } from '@ops-console/shared';

export type LoggedCall = { kind: ActionKind; target: string; command: string };

/** `mcp__<server>__<tool>`. */
export function mcpTool(toolName: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return match ? { server: match[1] ?? '', tool: match[2] ?? '' } : null;
}

function field(input: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}

/**
 * The Action Log row for a tool call, before redaction: every Bash call and every MCP tool call. Other tools (reads, edits inside
 * the working directory, web fetches) return `null` and are not logged.
 */
export function classifyCall(toolName: string, input: Record<string, unknown>, workingDir: string): LoggedCall | null {
  if (toolName === 'Bash') {
    const command = field(input, 'command') ?? '';
    const words = command.trim().split(/\s+/);
    const pr = (words[0] === 'gh' && words[1] === 'pr') || (words[0] === 'glab' && words[1] === 'mr');
    const kind = pr ? ActionKind.Pr : words[0] === 'git' ? ActionKind.Git : ActionKind.Shell;
    const number = pr ? words.slice(3).find((word) => /^\d+$/.test(word)) : undefined;
    return { kind, target: number ? `${workingDir}#${number}` : workingDir, command };
  }
  const mcp = mcpTool(toolName);
  if (!mcp) return null;
  const command = `${mcp.tool} ${JSON.stringify(input)}`;
  if (/slack/i.test(mcp.server)) {
    return { kind: ActionKind.Message, target: field(input, 'channel_id', 'channel') ?? mcp.server, command };
  }
  if (/atlassian|jira/i.test(mcp.server) && /issue/i.test(mcp.tool)) {
    return { kind: ActionKind.Ticket, target: field(input, 'issueIdOrKey', 'issueKey', 'key') ?? mcp.server, command };
  }
  return { kind: ActionKind.Query, target: mcp.server, command };
}
