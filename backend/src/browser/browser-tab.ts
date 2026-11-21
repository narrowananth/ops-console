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
  frameHeader,
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
import { ElementPicker } from './element-picker';
import { InspectorRelay } from './inspector-relay';
import { jpegSize } from './jpeg-size';

const RING = 200;
const MAX_HOSTS = 50;
/** The panel's frames: small, since the page changes under them all the time. */
const FRAME_QUALITY = 60;
/** What the agent reads in a screenshot. */
const SHOT_QUALITY = 70;
/** A viewer this far behind misses frames instead of queueing them. */
const MAX_BUFFERED = 1_000_000;
/** A frame is acknowledged once its viewers took it, or after this long, so one stalled viewer cannot freeze the rest. */
const ACK_WAIT_MS = 250;
/** A screenshot Chrome does not answer must not hold the queue that sizes the page. */
const STILL_WAIT_MS = 3000;

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome did not answer')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
/** Navigation events that arrive together are read once. */
const READ_WAIT_MS = 150;
type Fill = { width: number; height: number; dpr: number };
/** Until a viewer reports its size. */
const FILL_SIZE: Fill = { width: 1280, height: 800, dpr: 1 };

export type ConsoleEntry = { type: string; text: string };
export type NetworkEntry = { method: string; url: string; status: number | null };

export type TabHooks = {
  changed(sessionId: string): void;
  /** `requested` is false when the page closed itself or Chrome went away. */
  closed(tab: BrowserTab, requested: boolean): void;
  popup(opener: BrowserTab, page: Page): void;
};

type MouseMessage = Extract<BrowserClientMessage, { type: 'mouse' }>;
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

const conflict = (message: string): ApiError => new ApiError(409, ErrorCode.InvalidState, message);

/** The size, scale and touch mode a viewport asks for; `fill` is the panel's own size and pixel ratio. */
function effective(viewport: Viewport, fill: Fill) {
  const preset = VIEWPORT_PRESETS.find((p) => p.id === viewport.preset);
  const base =
    preset ??
    (viewport.width && viewport.height
      ? { width: viewport.width, height: viewport.height, scale: viewport.scale }
      : null);
  if (!base) return { width: fill.width, height: fill.height, scale: fill.dpr, mobile: false };
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
  /** Inspector windows attached; each holds a CDP session of its own. */
  private readonly inspectors = new Set<InspectorRelay>();
  /** Set when the daemon closes the page, so its close event is not a script's `window.close()` or a crash. */
  closing = false;
  dead = false;
  private agentCalls = 0;
  private buttons = 0;
  /** The page's CSS size and the device scale its frames are drawn at. */
  private size = { width: FILL_SIZE.width, height: FILL_SIZE.height, scale: FILL_SIZE.dpr };
  private fill = FILL_SIZE;
  /** Screenshots and size changes take turns: a screenshot restores the size it found when it finishes. */
  private sizing: Promise<unknown> = Promise.resolve();
  private lastInput: WebSocket | null = null;
  /** The size of a viewer that just took the tab, held until its first press, release, wheel or key has gone to the page it saw. */
  private takeover: Fill | null = null;
  private readonly viewerSizes = new Map<WebSocket, Fill>();
  private screencasting = false;
  private reading: NodeJS.Timeout | undefined;
  private inputQueue: Promise<void> = Promise.resolve();
  private moveQueued = false;
  /** The newest mouse move not yet sent: moves arriving while one is in flight replace each other. */
  private nextMove: MouseMessage | null = null;
  private readonly requests = new WeakMap<Request, NetworkEntry>();
  private readonly picker: ElementPicker;

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
    this.picker = new ElementPicker({
      cdp,
      size: () => this.size,
      turn: (work) => this.turn(work),
    });
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
      clearTimeout(this.reading);
      for (const dir of [...this.chosenDirs, ...(this.staged ? [this.staged.dir] : [])]) {
        void rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      this.hooks.closed(this, this.closing);
    });
    this.cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      // A screenshot with a clip, such as an element pick's crop, resizes the view while it is taken, and Chrome sends a
      // frame of that size. Drawn under the page's size it would show as the crop, magnified. The frame's own pixels
      // tell, since its metadata can lag the view on a slow machine: only a frame at the page's size goes out.
      // A pixel of tolerance: Chrome rounds a fractional size its own way.
      const pixels = jpegSize(data);
      const { width, height, scale } = this.size;
      const ofPage =
        pixels === null ||
        (Math.abs(pixels.width - width * scale) <= 1 && Math.abs(pixels.height - height * scale) <= 1);
      // Chrome sends the next frame after this ack, so a slow viewer slows the page down instead of queueing frames.
      void (ofPage ? this.sendFrame(data) : Promise.resolve())
        .then(() => this.cdp.send('Page.screencastFrameAck', { sessionId }))
        .catch(() => {});
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

  /** Reads title, icon and history after a navigation, once for the events that arrive together. */
  private refresh(): void {
    clearTimeout(this.reading);
    this.reading = setTimeout(() => void this.read().catch(() => {}), READ_WAIT_MS);
    this.reading.unref();
  }

  private async read(): Promise<void> {
    clearTimeout(this.reading);
    // Each read stands alone: a page that navigates under one of them must not lose the title.
    const [history, title, favicon] = await Promise.allSettled([
      this.cdp.send('Page.getNavigationHistory'),
      this.page.title(),
      this.page.evaluate<string | null>("document.querySelector('link[rel~=icon]')?.href ?? null"),
    ]);
    const failed = this.page.url().startsWith('chrome-error:');
    this.set({
      ...(history.status === 'fulfilled'
        ? {
            can_back: history.value.entries.slice(0, history.value.currentIndex).some(isPage),
            can_forward: history.value.currentIndex < history.value.entries.length - 1,
          }
        : {}),
      ...(failed || title.status !== 'fulfilled' ? {} : { title: title.value }),
      ...(failed || favicon.status !== 'fulfilled' ? {} : { favicon: favicon.value }),
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
      // The page is usable once its document is parsed; `loading` ends at the `load` event, which a slow image can hold.
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout });
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
    await Promise.all([
      this.cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: scale,
        mobile,
        screenWidth: width,
        screenHeight: height,
      }),
      this.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 }),
    ]);
    const resized = width !== this.size.width || height !== this.size.height || scale !== this.size.scale;
    this.size = { width, height, scale };
    // Frames are capped at the page's size in device pixels, so a new size or scale needs a screencast that knows it.
    if (resized && this.screencasting) {
      await this.cdp.send('Page.stopScreencast').catch(() => {});
      await this.startScreencast();
    }
    // Not awaited: it queues behind this turn.
    void this.refreshStill();
  }

  // Viewers

  private send(message: BrowserServerMessage, only?: WebSocket): void {
    const text = JSON.stringify(message);
    for (const viewer of only ? [only] : this.viewers) if (viewer.readyState === WebSocket.OPEN) viewer.send(text);
  }

  /** A frame is binary: the page's CSS size, then the JPEG. It resolves once the viewers it went to took it. */
  private async sendFrame(
    base64: string,
    size: { width: number; height: number } = this.size,
    only?: WebSocket,
  ): Promise<void> {
    const header = frameHeader(size.width, size.height);
    const jpeg = Buffer.from(base64, 'base64');
    const packet = Buffer.concat([header, jpeg]);
    const taken: Promise<void>[] = [];
    for (const viewer of only ? [only] : this.viewers) {
      if (viewer.readyState !== WebSocket.OPEN || viewer.bufferedAmount > MAX_BUFFERED) continue;
      taken.push(new Promise((resolve) => viewer.send(packet, { binary: true }, () => resolve())));
    }
    if (taken.length === 0) return;
    const timer = new Promise<void>((resolve) => setTimeout(resolve, ACK_WAIT_MS).unref());
    await Promise.race([Promise.all(taken), timer]);
  }

  async attach(viewer: WebSocket): Promise<void> {
    this.viewers.add(viewer);
    this.send({ type: 'tab', tab: this.snapshot() }, viewer);
    // A still page sends no screencast frame, so one screenshot shows it now. It goes out as soon as it is taken, in
    // turn with any size change, and does not wait for the screencast to start.
    const still = this.still().then(
      (shot) => this.sendFrame(shot.data, shot, viewer),
      () => {},
    );
    if (this.viewers.size === 1) await this.startScreencast();
    await still;
  }

  /** A JPEG of the page and the size it was taken at, read together inside the turn so they cannot disagree. */
  private still(): Promise<{ data: string; width: number; height: number }> {
    return this.turn(async () => {
      const { data } = await within(
        STILL_WAIT_MS,
        this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: FRAME_QUALITY }),
      );
      return { data, ...this.size };
    });
  }

  /** A page that has stopped changing sends no screencast frame, so a new size needs one frame of its own. */
  private async refreshStill(): Promise<void> {
    if (this.viewers.size === 0 || this.dead) return;
    const shot = await this.still().catch(() => null);
    if (shot) void this.sendFrame(shot.data, shot);
  }

  /** The page as a base64 JPEG for the agent. Through CDP because Playwright's own screenshot clears the size the panel set. */
  capture(): Promise<string> {
    return this.turn(async () => {
      // At the page's CSS size whatever the viewer's screen, so the agent's image does not grow with a Retina panel.
      const { width, height, scale } = this.size;
      const clip = { x: 0, y: 0, width, height, scale: 1 / scale };
      const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: SHOT_QUALITY, clip });
      return data;
    });
  }

  async detach(viewer: WebSocket): Promise<void> {
    this.viewers.delete(viewer);
    this.viewerSizes.delete(viewer);
    await this.picker.end(viewer);
    if (this.lastInput === viewer) {
      this.lastInput = null;
      this.takeover = null;
    }
    if (this.viewers.size === 0 && this.screencasting && !this.dead) {
      this.screencasting = false;
      await this.cdp.send('Page.stopScreencast').catch(() => {});
    }
  }

  private async startScreencast(): Promise<void> {
    this.screencasting = true;
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: FRAME_QUALITY,
      maxWidth: Math.round(this.size.width * this.size.scale),
      maxHeight: Math.round(this.size.height * this.size.scale),
      // Every frame: skipping any caps the page at 30 fps.
      everyNthFrame: 1,
    });
  }

  /** Tells viewers the tab is gone and hangs up on them, and on the Inspector windows. */
  closeViewers(): void {
    this.send({ type: 'closed' });
    for (const viewer of this.viewers) viewer.close(1000, 'tab_closed');
    for (const relay of [...this.inspectors]) relay.close(1000, 'tab_closed');
  }

  get inspectorCount(): number {
    return this.inspectors.size;
  }

  /** Gives an Inspector window a CDP session of its own on this page; the window's socket ends it. */
  inspect(socket: WebSocket): void {
    const relay = new InspectorRelay(this.page.context().newCDPSession(this.page), socket, (done) =>
      this.inspectors.delete(done),
    );
    this.inspectors.add(relay);
  }

  // Input from a viewer

  async input(viewer: WebSocket, message: BrowserClientMessage): Promise<void> {
    if (message.type === 'resize')
      return this.resize(viewer, { width: message.width, height: message.height, dpr: message.dpr });
    this.takeInput(viewer);
    if (message.type === 'focus') return;
    if (message.type === 'pick') return this.pick(viewer, message);
    if (message.type === 'mouse' && message.action === 'move') {
      // Moves are many and only the newest matters: one turn in the queue reads the newest at its time.
      this.nextMove = message;
      if (this.moveQueued) return;
      this.moveQueued = true;
      return this.inOrder(async () => {
        this.moveQueued = false;
        await this.flushMove();
      });
    }
    // Everything else goes one at a time in the order it came: a release never overtakes its press, nor a key its click.
    return this.inOrder(async () => {
      if (message.type === 'mouse') {
        await this.flushMove();
        await this.dispatchMouse(message);
      } else if (message.type === 'text') {
        await this.cdp.send('Input.insertText', { text: message.text });
      } else {
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
      }
      // A press that is not yet released must not see the page change under it.
      if (!(message.type === 'mouse' && message.action === 'down')) this.applyTakeover();
    });
  }

  /** Pick mode: the point is the page's CSS pixels. The capture goes back to the viewer that clicked, and to no other. */
  private async pick(viewer: WebSocket, message: Extract<BrowserClientMessage, { type: 'pick' }>): Promise<void> {
    if (message.action === 'start') return this.picker.start(viewer);
    if (message.action === 'end') return this.picker.end(viewer);
    if (!this.picker.has(viewer)) return;
    if (message.action === 'hover') return this.picker.hover(message.x, message.y);
    try {
      const capture = await this.picker.click(message.x, message.y);
      if (capture) this.send({ type: 'picked', capture }, viewer);
      // The viewer took the tab at the size it was shown; the page takes that size now the point has been read.
      this.applyTakeover();
    } catch (error) {
      this.send({ type: 'pick_failed', message: errorText(error) }, viewer);
    }
  }

  private inOrder(action: () => Promise<void>): Promise<void> {
    const turn = this.inputQueue.then(action);
    this.inputQueue = turn.catch(() => {});
    return turn;
  }

  private async flushMove(): Promise<void> {
    const move = this.nextMove;
    this.nextMove = null;
    if (move) await this.dispatchMouse(move);
  }

  private async dispatchMouse(message: MouseMessage): Promise<void> {
    const bit = CDP_BUTTONS[message.button];
    if (message.action === 'down') this.buttons |= bit;
    if (message.action === 'up') this.buttons &= ~bit;
    const sent = this.cdp.send('Input.dispatchMouseEvent', {
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
    // Chrome answers a move or a wheel only after it draws a frame, about 17 ms. Waiting for each made 120 wheel events
    // of one trackpad swipe take 2 s, and the page kept scrolling after the fingers stopped. The events still reach
    // Chrome in the order sent; only a press, a release or a key waits, so none overtakes another.
    if (message.action === 'move' || message.action === 'wheel') {
      sent.catch(() => {});
      return;
    }
    await sent;
  }

  /**
   * The tab shows the size of the viewer that sent input last. A viewer that takes over aimed at the page it was shown,
   * so its first press and release go to that page and the page takes the viewer's size after them.
   */
  private takeInput(viewer: WebSocket): void {
    if (this.lastInput === viewer) return;
    this.lastInput = viewer;
    this.takeover = this.viewerSizes.get(viewer) ?? null;
  }

  private applyTakeover(): void {
    const size = this.takeover;
    this.takeover = null;
    if (size) void this.fillTo(size);
  }

  private async resize(viewer: WebSocket, size: Fill): Promise<void> {
    this.viewerSizes.set(viewer, size);
    if (this.lastInput === null) this.lastInput = viewer;
    if (this.lastInput === viewer) {
      this.takeover = null;
      await this.fillTo(size);
    }
  }

  private async fillTo(size: Fill): Promise<void> {
    this.fill = size;
    const { preset, width: custom } = this.state.viewport;
    if (preset === null && custom === null) await this.applyMetrics().catch(() => {});
  }
}
