import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  type BrowserClientMessage,
  type BrowserServerMessage,
  ErrorCode,
  FILL_VIEWPORT,
  type Tab,
  TabAction,
  type TabOpener,
  VIEWPORT_PRESETS,
  type Viewport,
} from '@ops-console/shared';
import type { BrowserContext, CDPSession, FileChooser, Page, Request } from 'playwright-core';
import { WebSocket } from 'ws';
import { ApiError, validationFailed } from '../common/errors';
import { isLoopbackHost } from './addresses';

const RING = 200;
const MAX_HOSTS = 50;
const JPEG_QUALITY = 70;
/** A viewer this far behind misses frames instead of queueing them. */
const MAX_BUFFERED = 1_000_000;
/** Until a viewer reports its size. */
const FILL_SIZE = { width: 1280, height: 800 };

export type ConsoleEntry = { type: string; text: string };
export type NetworkEntry = { method: string; url: string; status: number | null };

export type TabHooks = {
  changed(sessionId: string): void;
  /** `requested` is false when the page closed itself or Chrome went away. */
  closed(tab: BrowserTab, requested: boolean): void;
  popup(opener: BrowserTab, page: Page): void;
};

const CDP_BUTTONS = { none: 0, left: 1, right: 2, middle: 4 } as const;
const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};
const MOUSE_TYPES = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased', wheel: 'mouseWheel' } as const;
const keyCode = (key: string): number => KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);

const push = <T>(ring: T[], item: T): void => {
  ring.push(item);
  if (ring.length > RING) ring.shift();
};

/** A history entry the operator can go to: the blank page a tab starts on is not one. */
const isPage = (entry: { url: string }): boolean => entry.url !== 'about:blank';

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What the operator reads when a page fails to load; null for a navigation that was only replaced by another. */
export function describeFailure(text: string, url: string): string | null {
  if (/ERR_ABORTED|interrupted by another navigation/.test(text)) return null;
  const address = URL.canParse(url) ? new URL(url) : null;
  if (/ERR_CONNECTION_REFUSED/.test(text)) {
    const port = address?.port || (address?.protocol === 'https:' ? '443' : '80');
    return `Nothing is listening on :${port}`;
  }
  if (/ERR_NAME_NOT_RESOLVED/.test(text)) return `Could not find ${address?.hostname ?? 'that host'}`;
  if (/Timeout/.test(text)) return 'The page took too long to load';
  return (
    /net::(ERR_[A-Z_]+)/.exec(text)?.[1] ?? text.replace(/^page\.\w+: /, '').split('\n')[0] ?? 'The page failed to load'
  );
}

/** The size, scale and touch mode a viewport asks for; `fill` is the panel's own size. */
const conflict = (message: string): ApiError => new ApiError(409, ErrorCode.InvalidState, message);

function effective(viewport: Viewport, fill: { width: number; height: number }) {
  const preset = VIEWPORT_PRESETS.find((p) => p.id === viewport.preset);
  const base =
    preset ??
    (viewport.width && viewport.height
      ? { width: viewport.width, height: viewport.height, scale: viewport.scale }
      : null);
  if (!base) return { ...fill, scale: 1, mobile: false };
  const [width, height] = viewport.rotated ? [base.height, base.width] : [base.width, base.height];
  return { width, height, scale: base.scale, mobile: /^(iphone|pixel)/.test(viewport.preset ?? '') };
}

/** A viewport is a known preset, or a width and height, or neither (Fill). */
export function checkViewport(viewport: Viewport): void {
  if (viewport.preset !== null) {
    if (!VIEWPORT_PRESETS.some((p) => p.id === viewport.preset)) throw validationFailed('unknown viewport preset');
  } else if ((viewport.width === null) !== (viewport.height === null)) {
    throw validationFailed('a custom viewport needs a width and a height');
  }
}

/** One page of a Session's Chrome: its state, what it logged, who watches it, and how input reaches it. */
export class BrowserTab {
  readonly id = randomUUID();
  readonly state: Tab;
  readonly consoleEntries: ConsoleEntry[] = [];
  readonly networkEntries: NetworkEntry[] = [];
  readonly viewers = new Set<WebSocket>();
  /** Set when the daemon closes the page, so its close event is not a script's `window.close()` or a crash. */
  closing = false;
  dead = false;
  private agentCalls = 0;
  private buttons = 0;
  private size = FILL_SIZE;
  private fill = FILL_SIZE;
  /** Screenshots and size changes take turns: a screenshot restores the size it found when it finishes. */
  private sizing: Promise<unknown> = Promise.resolve();
  private lastInput: WebSocket | null = null;
  private readonly viewerSizes = new Map<WebSocket, { width: number; height: number }>();
  private screencasting = false;
  private readonly requests = new WeakMap<Request, NetworkEntry>();

  private constructor(
    readonly page: Page,
    private readonly cdp: CDPSession,
    sessionId: string,
    openedBy: TabOpener,
    private readonly hooks: TabHooks,
  ) {
    this.state = {
      id: this.id,
      session_id: sessionId,
      url: '',
      title: '',
      favicon: null,
      loading: false,
      can_back: false,
      can_forward: false,
      viewport: { ...FILL_VIEWPORT },
      opened_by: openedBy,
      error: null,
      called_hosts: [],
      agent_active: false,
      file_chooser: null,
    };
    this.listen();
  }

  static async open(
    context: BrowserContext,
    page: Page,
    sessionId: string,
    openedBy: TabOpener,
    hooks: TabHooks,
  ): Promise<BrowserTab> {
    const tab = new BrowserTab(page, await context.newCDPSession(page), sessionId, openedBy, hooks);
    await tab.applyMetrics();
    if (page.url() !== 'about:blank') tab.refresh();
    return tab;
  }

  snapshot(): Tab {
    return { ...this.state, viewport: { ...this.state.viewport }, called_hosts: [...this.state.called_hosts] };
  }

  /** Applies a change and tells watchers when something differs. */
  private set(patch: Partial<Tab>): void {
    const differs = Object.entries(patch).some(([key, value]) => this.state[key as keyof Tab] !== value);
    if (!differs) return;
    Object.assign(this.state, patch);
    this.changed();
  }

  private changed(): void {
    this.send({ type: 'tab', tab: this.snapshot() });
    this.hooks.changed(this.state.session_id);
  }

  private listen(): void {
    const { page } = this;
    page.on('request', (request) => this.onRequest(request));
    page.on('response', (response) => {
      const entry = this.requests.get(response.request());
      if (entry) entry.status = response.status();
    });
    page.on('requestfailed', (request) => {
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
      const message = describeFailure(request.failure()?.errorText ?? '', request.url());
      this.set({ loading: false, ...(message ? { url: request.url(), error: message } : {}) });
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || page.url().startsWith('chrome-error:')) return;
      this.set({ url: page.url() === 'about:blank' ? '' : page.url(), error: null });
      this.refresh();
    });
    page.on('domcontentloaded', () => this.refresh());
    page.on('load', () => {
      this.set({ loading: false });
      this.refresh();
    });
    page.on('console', (message) => push(this.consoleEntries, { type: message.type(), text: message.text() }));
    page.on('pageerror', (error) => push(this.consoleEntries, { type: 'error', text: error.message }));
    page.on('dialog', (dialog) => {
      this.send({ type: 'dialog', kind: dialog.type(), message: dialog.message() });
      // A confirm or prompt the operator cannot answer is declined; the page's script goes on.
      const decline = dialog.type() === 'confirm' || dialog.type() === 'prompt';
      void (decline ? dialog.dismiss() : dialog.accept()).catch(() => {});
    });
    page.on('filechooser', (chooser) => {
      this.chooser = chooser;
      this.set({ file_chooser: { multiple: chooser.isMultiple() } });
    });
    page.on('download', (download) =>
      this.send({ type: 'dialog', kind: 'download', message: `Download refused: ${download.suggestedFilename()}` }),
    );
    page.on('crash', () => {
      if (!this.dead) this.set({ loading: false, error: 'The page crashed. Reload to try again.' });
    });
    page.on('popup', (popup) => this.hooks.popup(this, popup));
    page.on('close', () => {
      for (const dir of [...this.chosenDirs, ...(this.staged ? [this.staged.dir] : [])]) {
        void rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      this.hooks.closed(this, this.closing);
    });
    this.cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      void this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      this.send({ type: 'frame', data, ...this.size });
    });
  }

  private onRequest(request: Request): void {
    const entry: NetworkEntry = { method: request.method(), url: request.url(), status: null };
    this.requests.set(request, entry);
    push(this.networkEntries, entry);
    if (request.isNavigationRequest() && request.frame() === this.page.mainFrame()) this.set({ loading: true });
    const host = URL.canParse(entry.url) ? new URL(entry.url) : null;
    if (!host || !/^https?:$/.test(host.protocol) || isLoopbackHost(host.hostname)) return;
    const { called_hosts: called } = this.state;
    if (called.length < MAX_HOSTS && !called.includes(host.hostname))
      this.set({ called_hosts: [...called, host.hostname] });
  }

  /** Reads title, icon and history after a navigation; a page that moved on mid-read is read again by its next event. */
  private refresh(): void {
    void this.read().catch(() => {});
  }

  private async read(): Promise<void> {
    const [history, title, favicon] = await Promise.all([
      this.cdp.send('Page.getNavigationHistory'),
      this.page.title(),
      this.page.evaluate<string | null>("document.querySelector('link[rel~=icon]')?.href ?? null"),
    ]);
    const failed = this.page.url().startsWith('chrome-error:');
    this.set({
      can_back: history.entries.slice(0, history.currentIndex).some(isPage),
      can_forward: history.currentIndex < history.entries.length - 1,
      ...(failed ? {} : { title, favicon }),
    });
  }

  /** A page can change its own title; the service calls this on a timer. */
  async pollTitle(): Promise<void> {
    if (this.dead || this.state.error) return;
    const title = await this.page.title().catch(() => null);
    if (title !== null) this.set({ title });
  }

  /** Navigates and answers the failure the operator reads, or null. Never throws. */
  async load(url: string, timeout = 30_000): Promise<string | null> {
    this.set({ url, error: null, loading: true });
    try {
      await this.page.goto(url, { waitUntil: 'load', timeout });
      await this.read().catch(() => {});
      return null;
    } catch (error) {
      const message = describeFailure(errorText(error), url);
      this.set({ loading: false, ...(message ? { error: message } : {}) });
      return message;
    }
  }

  // The page's file picker

  private chooser: FileChooser | null = null;
  private readonly chosenDirs: string[] = [];
  private staged: { dir: string; files: Map<string, { name: string; file: string }> } | null = null;

  /** Keeps one file the operator picked, until `chooseFiles` hands the set to the page. */
  async stageFile(name: string, body: Readable): Promise<{ id: string; name: string; size: number }> {
    if (!this.chooser) throw conflict('The page is not asking for a file');
    if (!this.staged) this.staged = { dir: await mkdtemp(path.join(tmpdir(), 'ops-console-pick-')), files: new Map() };
    const dir = this.staged;
    const id = randomUUID();
    const shown = path.basename(name) || 'file';
    const folder = path.join(dir.dir, id);
    await mkdir(folder);
    const file = path.join(folder, shown);
    await pipeline(body, createWriteStream(file));
    dir.files.set(id, { name: shown, file });
    return { id, name: shown, size: (await stat(file)).size };
  }

  /** Gives the page the staged files, or none to cancel; the page sees the names the operator picked. */
  async chooseFiles(ids: string[]): Promise<void> {
    const chooser = this.chooser;
    if (!chooser) throw conflict('The page is not asking for a file');
    const staged = this.staged;
    const files = ids.map((id) => {
      const found = staged?.files.get(id);
      if (!found) throw validationFailed('a file was not staged for this tab');
      return found.file;
    });
    this.chooser = null;
    this.staged = null;
    this.set({ file_chooser: null });
    // The page reads a chosen file when it wants it, so the copy stays until the tab closes.
    if (staged) this.chosenDirs.push(staged.dir);
    await chooser.setFiles(files);
  }

  async act(action: TabAction): Promise<void> {
    if (action === TabAction.Reload) {
      if (this.state.url) void this.load(this.state.url);
    } else if (action === TabAction.Stop) {
      await this.cdp.send('Page.stopLoading');
      this.set({ loading: false });
    } else {
      const history = await this.cdp.send('Page.getNavigationHistory');
      const entry = history.entries[history.currentIndex + (action === TabAction.Back ? -1 : 1)];
      if (entry && isPage(entry)) await this.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    }
  }

  /** Runs `work` as an agent call: the panel shows "Agent is using this tab" until the last one ends. */
  async asAgent<T>(work: () => Promise<T>): Promise<T> {
    this.agentCalls += 1;
    this.set({ agent_active: true });
    try {
      return await work();
    } finally {
      this.agentCalls -= 1;
      if (this.agentCalls === 0) this.set({ agent_active: false });
    }
  }

  get agentBusy(): boolean {
    return this.agentCalls > 0;
  }

  markOpenedBy(opener: TabOpener): void {
    this.set({ opened_by: opener });
  }

  /** Chrome went away under this tab; it stays listed with the reason until the operator closes it. */
  die(message: string): void {
    this.dead = true;
    this.set({ loading: false, error: message });
  }

  // Viewport

  async setViewport(viewport: Viewport): Promise<void> {
    checkViewport(viewport);
    this.set({ viewport });
    await this.applyMetrics();
  }

  private turn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.sizing.then(work, work);
    this.sizing = next.catch(() => {});
    return next;
  }

  private applyMetrics(): Promise<void> {
    return this.turn(() => this.applyNow());
  }

  private async applyNow(): Promise<void> {
    const { width, height, scale, mobile } = effective(this.state.viewport, this.fill);
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile,
      screenWidth: width,
      screenHeight: height,
    });
    await this.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 });
    this.size = { width, height };
    // Not awaited: it queues behind this turn.
    void this.refreshStill();
  }

  // Viewers

  private send(message: BrowserServerMessage, only?: WebSocket): void {
    const text = JSON.stringify(message);
    for (const viewer of only ? [only] : this.viewers) {
      if (viewer.readyState !== WebSocket.OPEN) continue;
      if (message.type === 'frame' && viewer.bufferedAmount > MAX_BUFFERED) continue;
      viewer.send(text);
    }
  }

  async attach(viewer: WebSocket): Promise<void> {
    this.viewers.add(viewer);
    this.send({ type: 'tab', tab: this.snapshot() }, viewer);
    if (this.viewers.size === 1) await this.startScreencast();
    // A still page sends no screencast frame, so one screenshot shows it now.
    const shot = await this.still().catch(() => null);
    if (shot) this.send({ type: 'frame', ...shot }, viewer);
  }

  /** A JPEG of the page and the size it was taken at, read together inside the turn so they cannot disagree. */
  private still(): Promise<{ data: string; width: number; height: number }> {
    return this.turn(async () => {
      const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: JPEG_QUALITY });
      return { data, ...this.size };
    });
  }

  /** A page that has stopped changing sends no screencast frame, so a new size needs one frame of its own. */
  private async refreshStill(): Promise<void> {
    if (this.viewers.size === 0 || this.dead) return;
    const shot = await this.still().catch(() => null);
    if (shot) this.send({ type: 'frame', ...shot });
  }

  /** The page as base64. Through CDP because Playwright's own screenshot clears the size the panel set. */
  capture(format: 'jpeg' | 'png'): Promise<string> {
    return this.turn(async () => {
      const { data } = await this.cdp.send('Page.captureScreenshot', {
        format,
        ...(format === 'jpeg' ? { quality: JPEG_QUALITY } : {}),
      });
      return data;
    });
  }

  async detach(viewer: WebSocket): Promise<void> {
    this.viewers.delete(viewer);
    this.viewerSizes.delete(viewer);
    if (this.lastInput === viewer) this.lastInput = null;
    if (this.viewers.size === 0 && this.screencasting && !this.dead) {
      this.screencasting = false;
      await this.cdp.send('Page.stopScreencast').catch(() => {});
    }
  }

  private async startScreencast(): Promise<void> {
    this.screencasting = true;
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: JPEG_QUALITY,
      maxWidth: 3840,
      maxHeight: 3840,
    });
  }

  /** Tells viewers the tab is gone and hangs up on them. */
  closeViewers(): void {
    this.send({ type: 'closed' });
    for (const viewer of this.viewers) viewer.close(1000, 'tab_closed');
  }

  // Input from a viewer

  async input(viewer: WebSocket, message: BrowserClientMessage): Promise<void> {
    if (message.type === 'resize') return this.resize(viewer, message.width, message.height);
    this.takeInput(viewer);
    if (message.type === 'focus') return;
    if (message.type === 'text') {
      await this.cdp.send('Input.insertText', { text: message.text });
    } else if (message.type === 'key') {
      const text = message.text ?? (message.key === 'Enter' ? '\r' : undefined);
      const typed = message.action === 'down' && text !== undefined && (message.modifiers & 6) === 0;
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: message.action === 'up' ? 'keyUp' : typed ? 'keyDown' : 'rawKeyDown',
        key: message.key,
        code: message.code,
        modifiers: message.modifiers,
        windowsVirtualKeyCode: keyCode(message.key),
        ...(typed ? { text } : {}),
      });
    } else {
      await this.mouse(message);
    }
  }

  private async mouse(message: Extract<BrowserClientMessage, { type: 'mouse' }>): Promise<void> {
    const bit = CDP_BUTTONS[message.button];
    if (message.action === 'down') this.buttons |= bit;
    if (message.action === 'up') this.buttons &= ~bit;
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: MOUSE_TYPES[message.action],
      x: message.x,
      y: message.y,
      button: message.action === 'wheel' ? 'none' : message.button,
      buttons: this.buttons,
      clickCount: message.click_count,
      deltaX: message.delta_x,
      deltaY: message.delta_y,
      modifiers: message.modifiers,
    });
  }

  /** The tab shows the size of the viewer that sent input last. */
  private takeInput(viewer: WebSocket): void {
    if (this.lastInput === viewer) return;
    this.lastInput = viewer;
    const size = this.viewerSizes.get(viewer);
    if (size) void this.fillTo(size.width, size.height);
  }

  private async resize(viewer: WebSocket, width: number, height: number): Promise<void> {
    this.viewerSizes.set(viewer, { width, height });
    if (this.lastInput === null) this.lastInput = viewer;
    if (this.lastInput === viewer) await this.fillTo(width, height);
  }

  private async fillTo(width: number, height: number): Promise<void> {
    this.fill = { width, height };
    const { preset, width: custom } = this.state.viewport;
    if (preset === null && custom === null) await this.applyMetrics().catch(() => {});
  }
}
