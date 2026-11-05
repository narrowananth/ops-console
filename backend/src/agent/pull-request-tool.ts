import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ApiError } from '../common/errors';

/** The console's own MCP server, in the daemon: it holds the tools the console runs for the agent. */
export const CONSOLE_TOOLS_SERVER = 'ops-console';
export const OPEN_PULL_REQUEST_TOOL = `mcp__${CONSOLE_TOOLS_SERVER}__open_pull_request`;
export const JOIN_REPO_TOOL = `mcp__${CONSOLE_TOOLS_SERVER}__join_repo`;

export const joinRepoInputSchema = z.object({
  /** The Repo the operator means: its name, its path on this machine, or its Git URL or `owner/name`. */
  repo: z.string().trim().min(1),
});

export type JoinRepoInput = z.infer<typeof joinRepoInputSchema>;

/** What the agent's `join_repo` tool calls. The Workspace provides it. */
export interface RepoJoiner {
  /** Whether this run may ask to join a Repo: an Anonymous Session with no Alert behind it. */
  offers(sessionId: string): boolean;
  /** The words the operator's Approval shows. Throws an `ApiError` when no imported Repo matches. */
  describe(sessionId: string, input: JoinRepoInput): string;
  /** Moves the Session into the Repo; returns where it works now. */
  join(sessionId: string, input: JoinRepoInput): Promise<{ repo: string; branch: string | null }>;
}

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

/** The tool's answer to the agent: where the Session works now, or why it did not move. */
export async function runJoinRepo(
  joiner: RepoJoiner,
  sessionId: string,
  input: JoinRepoInput,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    const joined = await joiner.join(sessionId, input);
    return {
      content: [
        {
          type: 'text',
          text: `This Session now works in the Repo ${joined.repo}${joined.branch ? ` on branch ${joined.branch}` : ''}. Change nothing more in this empty folder. Reply with one short line that you are moving into the Repo: the console starts your next turn there, with the conversation so far. There you make a branch, commit, and ask for the pull request.`,
        },
      ],
    };
  } catch (error) {
    const why = error instanceof ApiError ? error.message : 'the Session did not move';
    return { content: [{ type: 'text', text: `The Session did not join the Repo: ${why}` }], isError: true };
  }
}

/** The console's tools for one run. The operator approves each call before it runs (see the runtime's PreToolUse hook). */
export function consoleToolsServer(
  tools: { opener: PullRequestOpener | null; joiner: RepoJoiner | null },
  sessionId: string,
): McpSdkServerConfigWithInstance {
  const { opener, joiner } = tools;
  return createSdkMcpServer({
    name: CONSOLE_TOOLS_SERVER,
    tools: [
      ...(opener
        ? [
            tool(
              'open_pull_request',
              "Pushes a branch and opens a pull request on the Repo's Git host, after the operator approves. Commit the work first. Never push or open one any other way.",
              openPullRequestInputSchema.shape,
              (args) => runOpenPullRequest(opener, sessionId, args),
            ),
          ]
        : []),
      ...(joiner
        ? [
            tool(
              'join_repo',
              "Moves this Session into a Repo the operator imported, after the operator approves, so you work in the real checkout on a branch and can commit and open a pull request. Use it when the operator names a repository or says where the issue is. Give the Repo's name, its path on this machine, or its Git URL.",
              joinRepoInputSchema.shape,
              (args) => runJoinRepo(joiner, sessionId, args),
            ),
          ]
        : []),
    ],
  });
}
