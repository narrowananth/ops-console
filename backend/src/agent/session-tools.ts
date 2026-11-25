import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ApiError } from '../common/errors';

/** The console's own MCP server, in the daemon: it holds the tools the console runs for the agent. */
export const CONSOLE_TOOLS_SERVER = 'ops-console';

const named = (name: string) => `mcp__${CONSOLE_TOOLS_SERVER}__${name}`;

export const BROWSER_OPEN_TOOL = named('browser_open');
export const BROWSER_SNAPSHOT_TOOL = named('browser_snapshot');
export const BROWSER_SCREENSHOT_TOOL = named('browser_screenshot');
export const BROWSER_CLICK_TOOL = named('browser_click');
export const BROWSER_TYPE_TOOL = named('browser_type');
export const BROWSER_PRESS_TOOL = named('browser_press');
export const BROWSER_SCROLL_TOOL = named('browser_scroll');
export const BROWSER_EVALUATE_TOOL = named('browser_evaluate');
export const BROWSER_CONSOLE_TOOL = named('browser_console');
export const BROWSER_NETWORK_TOOL = named('browser_network');
export const START_PROCESS_TOOL = named('start_process');
export const PROCESS_OUTPUT_TOOL = named('process_output');
export const STOP_PROCESS_TOOL = named('stop_process');

/** Every browser tool except `browser_evaluate`, which asks. They run with no Approval and are logged. */
export const BROWSER_QUIET_TOOLS: ReadonlySet<string> = new Set([
  BROWSER_OPEN_TOOL,
  BROWSER_SNAPSHOT_TOOL,
  BROWSER_SCREENSHOT_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_TYPE_TOOL,
  BROWSER_PRESS_TOOL,
  BROWSER_SCROLL_TOOL,
  BROWSER_CONSOLE_TOOL,
  BROWSER_NETWORK_TOOL,
]);

const tabId = z.string().min(1).optional();

export const browserOpenInputSchema = z.object({ url: z.string().min(1), tab_id: tabId });
export const browserTabInputSchema = z.object({ tab_id: tabId });
export const browserClickInputSchema = z.object({ ref: z.string().min(1), tab_id: tabId });
export const browserTypeInputSchema = z.object({
  ref: z.string().min(1),
  text: z.string(),
  submit: z.boolean().optional(),
  tab_id: tabId,
});
export const browserPressInputSchema = z.object({ key: z.string().min(1).max(40), tab_id: tabId });
export const browserScrollInputSchema = z.object({ dx: z.number().default(0), dy: z.number(), tab_id: tabId });
export const browserEvaluateInputSchema = z.object({ script: z.string().min(1).max(20_000), tab_id: tabId });
export const browserEntriesInputSchema = z.object({
  count: z.number().int().min(1).max(200).default(50),
  tab_id: tabId,
});

export const startProcessInputSchema = z.object({
  /** A short name for the process, such as `api` or `web`. */
  name: z.string().trim().min(1).max(60),
  command: z.string().trim().min(1).max(4000),
  /** The folder to run in: the Session's own folder when left out, or an Opened Repo's. */
  folder: z.string().min(1).max(4096).optional(),
});
export type StartProcessInput = z.infer<typeof startProcessInputSchema>;
export const processOutputInputSchema = z.object({
  name: z.string().min(1),
  lines: z.number().int().min(1).max(500).default(100),
});
export const stopProcessInputSchema = z.object({ name: z.string().min(1) });

/** What the browser tools call. The Browser module provides it. */
export interface BrowserTools {
  offers(sessionId: string): boolean;
  describeEvaluate(script: string): string;
  open(sessionId: string, url: string, tabId?: string): Promise<object>;
  snapshot(sessionId: string, tabId?: string): Promise<{ snapshot: string } & object>;
  screenshot(sessionId: string, tabId?: string): Promise<{ mimeType: 'image/jpeg'; base64: string }>;
  click(sessionId: string, ref: string, tabId?: string): Promise<object>;
  type(sessionId: string, ref: string, text: string, submit?: boolean, tabId?: string): Promise<object>;
  press(sessionId: string, key: string, tabId?: string): Promise<object>;
  scroll(sessionId: string, dx: number, dy: number, tabId?: string): Promise<object>;
  evaluate(sessionId: string, script: string, tabId?: string): Promise<string>;
  consoleEntries(sessionId: string, count: number, tabId?: string): Promise<object[]>;
  networkEntries(sessionId: string, count: number, tabId?: string): Promise<object[]>;
}

/** What the process tools call. The Processes module provides it. */
export interface ProcessTools {
  offers(sessionId: string): boolean;
  /** The words the operator's Approval shows. Throws an `ApiError` for a folder the Session may not use. */
  describeStart(
    sessionId: string,
    input: StartProcessInput,
  ): Promise<{ summary: string; folder: string; prod: string[] }>;
  startForAgent(sessionId: string, input: StartProcessInput): Promise<{ name: string; state: string }>;
  outputOf(sessionId: string, name: string, lines: number): string;
  stopByName(sessionId: string, name: string): Promise<{ name: string; state: string }>;
}

export type ToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
};

const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

/**
 * A Stop on the run ends the call: the tool answers at once with "Stopped by the operator." while the page's own work
 * finishes on its own. Two signals end it: the run's, and the one the MCP request carries when it is cancelled.
 */
export async function guarded(
  work: () => Promise<ToolResult>,
  failure: string,
  extra: unknown,
  runSignal: AbortSignal | undefined,
): Promise<ToolResult> {
  const signals = [runSignal, (extra as { signal?: AbortSignal } | undefined)?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const stopped: ToolResult = { content: [{ type: 'text', text: 'Stopped by the operator.' }], isError: true };
  try {
    if (signals.some((signal) => signal.aborted)) return stopped;
    const ended = new Promise<ToolResult>((resolve) => {
      for (const signal of signals) signal.addEventListener('abort', () => resolve(stopped), { once: true });
    });
    return await Promise.race([work(), ended]);
  } catch (error) {
    const why = error instanceof ApiError ? error.message : failure;
    return { content: [{ type: 'text', text: why }], isError: true };
  }
}

/** The browser and process tools of one run. The runtime's PreToolUse hook gates each call. */
export function sessionTools(
  browser: BrowserTools | null,
  processes: ProcessTools | null,
  sessionId: string,
  runSignal?: AbortSignal,
) {
  const guard = (work: () => Promise<ToolResult>, failure: string, extra: unknown) =>
    guarded(work, failure, extra, runSignal);
  return [
    ...(browser
      ? [
          tool(
            'browser_open',
            "Opens a page in the Session's browser panel, which the operator watches. Loopback addresses only (localhost, 127.0.0.1, [::1]): a dev server this Session runs. Waits for the page to load. Start the server first with start_process, or ask the operator to.",
            browserOpenInputSchema.shape,
            (args, extra) =>
              guard(
                async () => text(await browser.open(sessionId, args.url, args.tab_id)),
                'The page did not open.',
                extra,
              ),
          ),
          tool(
            'browser_snapshot',
            'Returns the page as an accessibility tree. Each element has a ref such as e12; browser_click and browser_type take it. Read the page again after it changes.',
            browserTabInputSchema.shape,
            (args, extra) =>
              guard(async () => text(await browser.snapshot(sessionId, args.tab_id)), 'No snapshot.', extra),
          ),
          tool(
            'browser_screenshot',
            'Takes a picture of the page. It is shown in the conversation and saved nowhere else.',
            browserTabInputSchema.shape,
            (args, extra) =>
              guard(
                async () => {
                  const shot = await browser.screenshot(sessionId, args.tab_id);
                  return { content: [{ type: 'image' as const, data: shot.base64, mimeType: shot.mimeType }] };
                },
                'No screenshot.',
                extra,
              ),
          ),
          tool(
            'browser_click',
            'Clicks the element with this ref from the last browser_snapshot.',
            browserClickInputSchema.shape,
            (args, extra) =>
              guard(
                async () => text(await browser.click(sessionId, args.ref, args.tab_id)),
                'The click failed.',
                extra,
              ),
          ),
          tool(
            'browser_type',
            'Types text into the element with this ref, and presses Enter after it when submit is true.',
            browserTypeInputSchema.shape,
            (args, extra) =>
              guard(
                async () => text(await browser.type(sessionId, args.ref, args.text, args.submit ?? false, args.tab_id)),
                'The text was not typed.',
                extra,
              ),
          ),
          tool(
            'browser_press',
            'Presses one key on the page, such as Enter, Escape, Tab or ArrowDown.',
            browserPressInputSchema.shape,
            (args, extra) =>
              guard(
                async () => text(await browser.press(sessionId, args.key, args.tab_id)),
                'The key was not pressed.',
                extra,
              ),
          ),
          tool(
            'browser_scroll',
            'Scrolls the page by dx and dy pixels.',
            browserScrollInputSchema.shape,
            (args, extra) =>
              guard(
                async () => text(await browser.scroll(sessionId, args.dx, args.dy, args.tab_id)),
                'The page did not scroll.',
                extra,
              ),
          ),
          tool(
            'browser_evaluate',
            'Runs a script in the page and returns its result as JSON. The operator approves each script. Use browser_snapshot and browser_click first; use this for what they cannot read.',
            browserEvaluateInputSchema.shape,
            (args, extra) =>
              guard(
                async () => text(await browser.evaluate(sessionId, args.script, args.tab_id)),
                'The script failed.',
                extra,
              ),
          ),
          tool(
            'browser_console',
            "Returns the page's last console messages.",
            browserEntriesInputSchema.shape,
            (args, extra) =>
              guard(
                async () => text(await browser.consoleEntries(sessionId, args.count, args.tab_id)),
                'No console messages.',
                extra,
              ),
          ),
          tool(
            'browser_network',
            "Returns the page's last requests with their status.",
            browserEntriesInputSchema.shape,
            (args, extra) =>
              guard(
                async () => text(await browser.networkEntries(sessionId, args.count, args.tab_id)),
                'No requests.',
                extra,
              ),
          ),
        ]
      : []),
    ...(processes
      ? [
          tool(
            'start_process',
            "Starts a long-running command, such as a dev server, in the Session's Terminals panel, after the operator approves it. It runs as the operator, outside your sandbox, with the Repo's environment, and keeps running after your turn. Give a short name and the command. Then read its output with process_output and open its address with browser_open.",
            startProcessInputSchema.shape,
            (args, extra) =>
              guard(
                async () => {
                  const started = await processes.startForAgent(sessionId, args);
                  return text(
                    `Started ${started.name} (${started.state}). Read its output with process_output; open its address with browser_open once it listens.`,
                  );
                },
                'The process did not start.',
                extra,
              ),
          ),
          tool(
            'process_output',
            "Returns the last lines of a Session process's output, such as the address a dev server listens on.",
            processOutputInputSchema.shape,
            (args, extra) =>
              guard(async () => text(processes.outputOf(sessionId, args.name, args.lines)), 'No such process.', extra),
          ),
          tool(
            'stop_process',
            'Stops a process of this Session by name.',
            stopProcessInputSchema.shape,
            (args, extra) =>
              guard(async () => text(await processes.stopByName(sessionId, args.name)), 'No such process.', extra),
          ),
        ]
      : []),
  ];
}
