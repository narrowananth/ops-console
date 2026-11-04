import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ApiError } from '../common/errors';

/** The console's own MCP server, in the daemon: it holds the tools the console runs for the agent. */
export const CONSOLE_TOOLS_SERVER = 'ops-console';
export const OPEN_PULL_REQUEST_TOOL = `mcp__${CONSOLE_TOOLS_SERVER}__open_pull_request`;

export const openPullRequestInputSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string(),
  /** The branch the pull request merges into; the Repo's default branch when left out. */
  base_branch: z.string().trim().min(1).optional(),
  /** The branch to push; the branch checked out in the Repo's folder when left out. */
  branch: z.string().trim().min(1).optional(),
});

export type OpenPullRequestInput = z.infer<typeof openPullRequestInputSchema>;

/** What the agent's `open_pull_request` tool calls. The Workspace provides it. */
export interface PullRequestOpener {
  /** Whether a run working in `dir` for this Session may open a pull request: a Session in a Repo, on a supported Git host. */
  offers(sessionId: string, dir: string): boolean;
  /** The words the operator's Approval shows. Throws an `ApiError` when no pull request can open. */
  describe(sessionId: string, input: OpenPullRequestInput): Promise<string>;
  /** Pushes the branch and opens the pull request; an open one for the branch is returned. */
  open(sessionId: string, input: OpenPullRequestInput): Promise<{ number: number; url: string }>;
}

/** The tool's answer to the agent: the link, or why nothing opened. */
export async function runOpenPullRequest(
  opener: PullRequestOpener,
  sessionId: string,
  input: OpenPullRequestInput,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    const opened = await opener.open(sessionId, input);
    return { content: [{ type: 'text', text: `Opened pull request #${opened.number}: ${opened.url}` }] };
  } catch (error) {
    const why = error instanceof ApiError ? error.message : 'the pull request did not open';
    return { content: [{ type: 'text', text: `No pull request was opened: ${why}` }], isError: true };
  }
}

/** The console's tools for one run. The operator approves each call before it runs (see the runtime's PreToolUse hook). */
export function consoleToolsServer(opener: PullRequestOpener, sessionId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: CONSOLE_TOOLS_SERVER,
    tools: [
      tool(
        'open_pull_request',
        "Pushes a branch and opens a pull request on the Repo's Git host, after the operator approves. Commit the work first. Never push or open one any other way.",
        openPullRequestInputSchema.shape,
        (args) => runOpenPullRequest(opener, sessionId, args),
      ),
    ],
  });
}
