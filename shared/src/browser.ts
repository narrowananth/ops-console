import { z } from 'zod';

export enum TabOpener {
  Operator = 'operator',
  Agent = 'agent',
}

export enum ProcessState {
  Running = 'running',
  Exited = 'exited',
  Stopped = 'stopped',
}

export enum ChromeState {
  Ready = 'ready',
  Missing = 'missing',
}

export enum TabAction {
  Back = 'back',
  Forward = 'forward',
  Reload = 'reload',
  Stop = 'stop',
}

/** The console's own ports: the installed app and the dev frontend and backend. */
export const CONSOLE_PORTS = [4545, 4555, 4556] as const;

/** `width` and `height` null means the panel's own size. */
export const viewportSchema = z.object({
  preset: z.string().nullable(),
  width: z.number().int().min(240).max(3840).nullable(),
  height: z.number().int().min(240).max(3840).nullable(),
  scale: z.number().min(1).max(4),
  rotated: z.boolean(),
});
export type Viewport = z.infer<typeof viewportSchema>;

export const FILL_VIEWPORT: Viewport = { preset: null, width: null, height: null, scale: 1, rotated: false };

export const VIEWPORT_PRESETS: readonly { id: string; label: string; width: number; height: number; scale: number }[] =
  [
    { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667, scale: 2 },
    { id: 'iphone-14-pro-max', label: 'iPhone 14 Pro Max', width: 430, height: 932, scale: 3 },
    { id: 'pixel-7', label: 'Pixel 7', width: 412, height: 915, scale: 2.625 },
    { id: 'ipad-mini', label: 'iPad Mini', width: 768, height: 1024, scale: 2 },
    { id: 'laptop-1440x900', label: 'Desktop 1440×900', width: 1440, height: 900, scale: 1 },
    { id: 'desktop-1920x1080', label: 'Desktop 1920×1080', width: 1920, height: 1080, scale: 1 },
  ];

export const tabSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  url: z.string(),
  title: z.string(),
  favicon: z.string().nullable(),
  loading: z.boolean(),
  can_back: z.boolean(),
  can_forward: z.boolean(),
  viewport: viewportSchema,
  opened_by: z.enum(TabOpener),
  error: z.string().nullable(),
  /** Outside hosts the page called, for the operator to read. Nothing is blocked. */
  called_hosts: z.array(z.string()),
  /** True while an agent tool call is running on this tab. */
  agent_active: z.boolean(),
  /** Set while the page waits for the operator to pick a file. */
  file_chooser: z.object({ multiple: z.boolean() }).nullable(),
});
export type Tab = z.infer<typeof tabSchema>;

export const browserStateSchema = z.object({ chrome: z.enum(ChromeState), tabs: z.array(tabSchema) });
export type BrowserState = z.infer<typeof browserStateSchema>;

export const chooseFilesBodySchema = z.object({ ids: z.array(z.string().min(1)).max(50) });
export type ChooseFilesBody = z.infer<typeof chooseFilesBodySchema>;

export const stagedFileSchema = z.object({ id: z.string(), name: z.string(), size: z.number().int() });
export type StagedFile = z.infer<typeof stagedFileSchema>;

export const createTabBodySchema = z.object({ url: z.string().min(1).max(2048).optional() });
export type CreateTabBody = z.infer<typeof createTabBodySchema>;

export const patchTabBodySchema = z.object({
  url: z.string().min(1).max(2048).optional(),
  action: z.enum(TabAction).optional(),
  viewport: viewportSchema.optional(),
});
export type PatchTabBody = z.infer<typeof patchTabBodySchema>;

export const sessionProcessSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  name: z.string(),
  command: z.string(),
  folder: z.string(),
  state: z.enum(ProcessState),
  exit_code: z.number().int().nullable(),
  started_at: z.string(),
  started_by: z.enum(TabOpener),
  /** PROD Connections whose host the folder's `.env` files name, read when the process started. */
  prod_connections: z.array(z.string()),
});
export type SessionProcess = z.infer<typeof sessionProcessSchema>;

export const localServerSchema = z.object({
  port: z.number().int(),
  process: z.string(),
  folder: z.string(),
  /** Set when the server runs in this Session's folders or under one of its processes. */
  session_id: z.string().nullable(),
  process_id: z.string().nullable(),
});
export type LocalServer = z.infer<typeof localServerSchema>;

export const localServersSchema = z.object({ servers: z.array(localServerSchema) });

export const scriptsSchema = z.object({
  runner: z.enum(['pnpm', 'npm', 'yarn', 'bun']),
  scripts: z.array(z.object({ name: z.string(), command: z.string() })),
});
export type Scripts = z.infer<typeof scriptsSchema>;

/** `script` or `command`, not both; neither opens a shell. */
export const createProcessBodySchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    command: z.string().min(1).max(4000).optional(),
    script: z.string().min(1).max(200).optional(),
    folder: z.string().min(1).max(4096).optional(),
  })
  .refine((body) => !(body.command && body.script), { message: 'Give a command or a script, not both' });
export type CreateProcessBody = z.infer<typeof createProcessBodySchema>;

const modifiers = z.number().int().min(0).max(15);

/** Browser panel to daemon, over `/browser/:tabId`. */
export const browserClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('mouse'),
    action: z.enum(['move', 'down', 'up', 'wheel']),
    x: z.number(),
    y: z.number(),
    button: z.enum(['left', 'middle', 'right', 'none']).default('none'),
    click_count: z.number().int().min(0).max(3).default(0),
    delta_x: z.number().default(0),
    delta_y: z.number().default(0),
    modifiers: modifiers.default(0),
  }),
  z.object({
    type: z.literal('key'),
    action: z.enum(['down', 'up']),
    key: z.string().max(40),
    code: z.string().max(40),
    text: z.string().max(8).optional(),
    modifiers: modifiers.default(0),
  }),
  z.object({ type: z.literal('text'), text: z.string().max(100_000) }),
  z.object({
    type: z.literal('resize'),
    width: z.number().int().min(100).max(3840),
    height: z.number().int().min(100).max(3840),
  }),
  z.object({ type: z.literal('focus') }),
]);
export type BrowserClientMessage = z.infer<typeof browserClientMessageSchema>;

/** Daemon to browser panel. `frame` carries a base64 JPEG. */
export const browserServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('frame'), data: z.string(), width: z.number(), height: z.number() }),
  z.object({ type: z.literal('tab'), tab: tabSchema }),
  z.object({ type: z.literal('dialog'), kind: z.string(), message: z.string() }),
  z.object({ type: z.literal('closed') }),
]);
export type BrowserServerMessage = z.infer<typeof browserServerMessageSchema>;

/** Process stream, over `/processes/:id`. */
export const processClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(100_000) }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(300),
  }),
]);
export type ProcessClientMessage = z.infer<typeof processClientMessageSchema>;

export const processServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output'), data: z.string() }),
  z.object({ type: z.literal('exit'), code: z.number().int().nullable() }),
]);
export type ProcessServerMessage = z.infer<typeof processServerMessageSchema>;
