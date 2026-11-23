import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from '@anthropic-ai/claude-agent-sdk';
import { FindingSeverity, PrAction, ReplyVerdict, ReviewVerdict, ThreadOutcome } from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import { type IntegrationRunner, integrationInputSchema } from './integration-cli';
import { type NewRelicQuery, newRelicQueryInputSchema, runNewRelicQuery } from './new-relic-tool';
import { type FileSaver, runSaveFile, saveFileInputSchema } from './output-files';
import { type BrowserTools, CONSOLE_TOOLS_SERVER, type ProcessTools, sessionTools } from './session-tools';

export { CONSOLE_TOOLS_SERVER };
export const OPEN_PULL_REQUEST_TOOL = `mcp__${CONSOLE_TOOLS_SERVER}__open_pull_request`;
export const JOIN_REPO_TOOL = `mcp__${CONSOLE_TOOLS_SERVER}__join_repo`;
export const SPAWN_SESSIONS_TOOL = `mcp__${CONSOLE_TOOLS_SERVER}__spawn_sessions`;
export const SAVE_FILE_TOOL = `mcp__${CONSOLE_TOOLS_SERVER}__save_file`;
export const RUN_INTEGRATION_TOOL = `mcp__${CONSOLE_TOOLS_SERVER}__run_integration`;
export const SUBMIT_THREAD_RESULTS_TOOL = `mcp__${CONSOLE_TOOLS_SERVER}__submit_thread_results`;
export const SUBMIT_REPLY_VERDICTS_TOOL = `mcp__${CONSOLE_TOOLS_SERVER}__submit_reply_verdicts`;
export const SUBMIT_REVIEW_TOOL = `mcp__${CONSOLE_TOOLS_SERVER}__submit_review`;

/** The console tool each PR action Session is offered: the one call that posts its results to the Git host. */
export const PR_ACTION_TOOLS: Record<PrAction, string> = {
  [PrAction.AddressComments]: SUBMIT_THREAD_RESULTS_TOOL,
  [PrAction.CheckReplies]: SUBMIT_REPLY_VERDICTS_TOOL,
  [PrAction.Review]: SUBMIT_REVIEW_TOOL,
};

export const submitThreadResultsInputSchema = z.object({
  threads: z.array(
    z.object({
      comment_id: z.string().min(1),
      outcome: z.enum([ThreadOutcome.Done, ThreadOutcome.AlreadyAddressed, ThreadOutcome.Declined]),
      reply: z.string().trim().min(1),
    }),
  ),
});

export const submitReplyVerdictsInputSchema = z.object({
  threads: z.array(
    z.object({
      comment_id: z.string().min(1),
      verdict: z.enum(ReplyVerdict),
      reply: z.string().trim().min(1),
    }),
  ),
});

/** What `submit_review` takes: the verdict, the findings the console posts on their lines, and the full report. */
export const submitReviewInputSchema = z.object({
  decision: z.enum(ReviewVerdict),
  verdict: z.string(),
  findings: z.array(
    z.object({
      severity: z.enum(FindingSeverity),
      file: z.string().nullish(),
      line: z.number().int().nullish(),
      text: z.string().min(1),
    }),
  ),
  report: z.string().default(''),
});

export type ReviewOutput = z.infer<typeof submitReviewInputSchema>;

/** What the agent's submit tools call. The Workspace provides it. */
export interface PrActionTools {
  /** The action this Session was opened for; null for any other Session. */
  action(sessionId: string): PrAction | null;
  /** Posts the Session's results to the Git host. Throws an `ApiError` that says why nothing, or not everything, was posted. */
  submit(sessionId: string, input: unknown): Promise<string>;
}

/** The tool's answer to the agent: what was posted, or why not. */
export async function runPrActionTool(
  tools: PrActionTools,
  sessionId: string,
  input: unknown,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    return { content: [{ type: 'text', text: await tools.submit(sessionId, input) }] };
  } catch (error) {
    const why = error instanceof ApiError ? error.message : 'nothing was posted';
    return { content: [{ type: 'text', text: why }], isError: true };
  }
}

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

export const spawnSessionsInputSchema = z.object({
  /** One entry per Repo: the Repo's name, path or Git URL, and the task its Session starts with. */
  sessions: z.array(z.object({ repo: z.string().trim().min(1), task: z.string().trim().min(1) })).min(1),
});

export type SpawnSessionsInput = z.infer<typeof spawnSessionsInputSchema>;

/** What became of one entry of a `spawn_sessions` call. */
export type SpawnedEntry = { repo: string; sessionId: string | null; error: string | null };

/** What the agent's `spawn_sessions` tool calls. The Workspace provides it. */
export interface SessionSpawner {
  /** Whether this run may spawn: a chat run the operator started, in a Session no other Session spawned. */
  offers(sessionId: string): boolean;
  /** Checks every entry and returns the words the operator's Approval shows. Throws an `ApiError` when the batch is refused. */
  describe(sessionId: string, input: SpawnSessionsInput): string;
  /** Makes a Session per entry and starts its run. A Session that cannot start is reported, and the others go on. */
  spawn(sessionId: string, input: SpawnSessionsInput, callId: string): Promise<SpawnedEntry[]>;
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
  /** Throws an `ApiError` when no pull request can open. Returns a one-line description. */
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

/** The tool's answer to the agent: one line per entry, or why nothing started. */
export async function runSpawnSessions(
  spawner: SessionSpawner,
  sessionId: string,
  input: SpawnSessionsInput,
  callId: string,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    const entries = await spawner.spawn(sessionId, input, callId);
    const lines = entries.map((entry) =>
      entry.sessionId === null
        ? `failed ${entry.repo}: ${entry.error ?? 'did not start'}`
        : `started ${entry.repo} as Session ${entry.sessionId}`,
    );
    return {
      content: [
        {
          type: 'text',
          text: `${lines.join('\n')}\nEach Session works alone and opens its own pull request. Reply with one short line: the console shows their progress under this turn. Do not wait for them.`,
        },
      ],
    };
  } catch (error) {
    const why = error instanceof ApiError ? error.message : 'the Sessions did not start';
    return { content: [{ type: 'text', text: `No Sessions were started: ${why}` }], isError: true };
  }
}

/** The console's tools for one run. The runtime's PreToolUse hook gates each call: joining a Repo and saving a file ask the operator, an integration write asks, a read and a pull request do not. */
export function consoleToolsServer(
  tools: {
    opener: PullRequestOpener | null;
    /** A PR action Session's one submit tool: which, and who posts. */
    prAction?: { action: PrAction; tools: PrActionTools } | null;
    joiner: RepoJoiner | null;
    spawner?: SessionSpawner | null;
    /** The tool-use id of the `spawn_sessions` call being run, set by the approval hook. */
    spawnCallId?: () => string;
    saver: FileSaver | null;
    integrations?: IntegrationRunner | null;
    /** New Relic logs read with a User API key, which only the daemon holds. */
    newRelic?: NewRelicQuery | null;
    browser?: BrowserTools | null;
    processes?: ProcessTools | null;
    /** Aborts when the operator stops the run. */
    signal?: AbortSignal;
  },
  sessionId: string,
): McpSdkServerConfigWithInstance {
  const {
    opener,
    prAction = null,
    joiner,
    spawner = null,
    spawnCallId = () => '',
    saver,
    integrations = null,
    newRelic = null,
    browser = null,
    processes = null,
    signal,
  } = tools;
  return createSdkMcpServer({
    name: CONSOLE_TOOLS_SERVER,
    tools: [
      ...(opener
        ? [
            tool(
              'open_pull_request',
              "Pushes a branch and opens a pull request on the Repo's Git host, with no Approval. When the branch has a pull request already, it pushes the new commits and returns that pull request's link. A branch that moved on origin is rebased onto it first, never forced. Commit the work first. Never push or open one any other way.",
              openPullRequestInputSchema.shape,
              (args) => runOpenPullRequest(opener, sessionId, args),
            ),
          ]
        : []),
      ...(prAction ? [submitTool(prAction.action, prAction.tools, sessionId)] : []),
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
      ...(spawner
        ? [
            tool(
              'spawn_sessions',
              "Starts a Session in each of several imported Repos at once, after the operator approves the whole list, so the Repos' tasks run in parallel. Give one entry per Repo: the Repo's name, path or Git URL, and the task for its Session, written so the agent there needs nothing else (it does not see this conversation). Each Session works on its own branch and opens its own pull request. Not for the Repo this Session works in: do that work here.",
              spawnSessionsInputSchema.shape,
              (args) => runSpawnSessions(spawner, sessionId, args, spawnCallId()),
            ),
          ]
        : []),
      ...(integrations
        ? [
            tool(
              'run_integration',
              "Runs an integration CLI (pup for Datadog, gh, glab, bkt, slashdocs) outside your sandbox, as the operator, where their sign-in works. Give cli and args: the command words first, then the flags, one argument per entry, no shell (for example gh with args pr, view, 12, --repo, owner/name). A read runs at once. A write (comment, create, update, mute) waits for the operator's Approval. Sign-in, tokens, extensions, aliases, config and merges are refused. Your commands cannot run these CLIs themselves.",
              integrationInputSchema.shape,
              async (args) => {
                const done = await integrations.run(args);
                return { content: [{ type: 'text' as const, text: done.text }], ...(done.ok ? {} : { isError: true }) };
              },
            ),
          ]
        : []),
      ...(newRelic
        ? [
            tool(
              'query_new_relic',
              "Runs one read-only NRQL query against the New Relic account the console reads logs from, with the console's own User API key, and returns the rows (at most 200). Give the NRQL text only: a SELECT or FROM query, or SHOW EVENT TYPES, with its own SINCE and LIMIT. The account and Region are fixed. Runs at once, with no Approval, and is logged.",
              newRelicQueryInputSchema.shape,
              (args) => runNewRelicQuery(newRelic, args),
            ),
          ]
        : []),
      ...(saver
        ? [
            tool(
              'save_file',
              "Copies a file, or a whole folder with its files, from your output folder into a folder the operator names, such as ~/Downloads or ~/Documents. Your commands cannot write there, in any Access mode. The operator approves first unless the Session has full access. Give the name of the file or folder in your output folder and the destination folder's absolute path. A folder is copied as a new folder of that name inside the destination, so to make ~/Documents/sample-project, build sample-project in your output folder and save it to ~/Documents. A folder or file that is already there is never merged into; a file of the same name is replaced.",
              saveFileInputSchema.shape,
              (args) => runSaveFile(saver, sessionId, args),
            ),
          ]
        : []),
      ...sessionTools(browser, processes, sessionId, signal),
    ],
  });
}

/** The one tool a PR action Session has for its results. */
function submitTool(action: PrAction, tools: PrActionTools, sessionId: string) {
  const run = (args: unknown) => runPrActionTool(tools, sessionId, args);
  switch (action) {
    case PrAction.AddressComments:
      return tool(
        'submit_thread_results',
        "Reports what you did with each thread the operator ticked, once your work is done. Give every ticked thread's comment_id exactly once, with outcome done, already_addressed or declined and a reply: what you changed (done), the code that already settles it (already_addressed), or why not (declined). Write the reply in plain words, without the outcome name and without commit hashes: the console adds the new commit to a done reply. The console then commits your changes in one commit, pushes it to the pull request's branch, posts each reply in its thread and resolves the done and already_addressed ones. Commit nothing and push nothing yourself. A refused call says why; fix it and call again.",
        submitThreadResultsInputSchema.shape,
        run,
      );
    case PrAction.CheckReplies:
      return tool(
        'submit_reply_verdicts',
        "Gives your verdict on each thread you checked, once you are done. Give every thread's comment_id exactly once, with verdict fixed, partly_fixed or not_fixed and a reply for the thread. The console posts each reply and resolves the fixed ones. Nothing you changed in this folder is kept. A refused call says why; fix it and call again.",
        submitReplyVerdictsInputSchema.shape,
        run,
      );
    case PrAction.Review:
      return tool(
        'submit_review',
        'Submits your review of the pull request once it is done: the decision, a one-sentence verdict, the findings and the full report. The console posts each finding on its line and the summary on the pull request. Nothing you changed in this folder is kept. A refused call says why; fix it and call again.',
        submitReviewInputSchema.shape,
        run,
      );
  }
}
