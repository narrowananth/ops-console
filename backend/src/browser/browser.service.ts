import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  type BrowserClientMessage,
  type BrowserState,
  ChromeState,
  ErrorCode,
  type PatchTabBody,
  SessionKind,
  type StagedFile,
  TabOpener,
} from '@ops-console/shared';
import { type BrowserContext, chromium, type Page } from 'playwright-core';
import type { WebSocket } from 'ws';
import { SessionsService } from '../agent/sessions.service';
import { DATA_DIR } from '../common/data-dir';
import { ApiError } from '../common/errors';
import { STORE, type Store } from '../db/store';
import { normalizeAddress } from './addresses';
import {
  BROWSER_OPTIONS,
  type BrowserOptions,
  DEFAULT_IDLE_MS,
  findChrome,
  openInDefaultBrowser,
} from './browser-options';
import { BrowserTab, type TabHooks } from './browser-tab';
import { killOrphanChromes } from './orphans';

const TITLE_POLL_MS = 2000;
/** Chrome with nothing the console shows: no extensions, updates, sync or background requests. */
const LAUNCH_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-component-update',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-features=Translate,MediaRouter,OptimizationHints',
  '--password-store=basic',
];
const CHROME_STOPPED = 'Chrome stopped. Close this tab and open a new one.';

type Slot = {
  sessionId: string;
  profile: string;
  /** The launch in flight or done; null when no Chrome runs. */
  context: Promise<BrowserContext> | null;
  /** The page Chrome opens with, kept for the first tab. */
  spare: Page | undefined;
  tabs: BrowserTab[];
  idle: NodeJS.Timeout | undefined;
  titles: NodeJS.Timeout | undefined;
  /** Set while the daemon closes this Chrome; the slot leaves the map when it is done. */
  stopping: Promise<void> | null;
  /** Chrome exited without being asked to. */
  crashed: boolean;
};

/** A Session's Chrome and tabs: one Chrome per Session, started on its first tab and closed after the idle time. */
@Injectable()
export class BrowserService implements OnModuleInit, OnModuleDestroy {
  private readonly slots = new Map<string, Slot>();
  private readonly byId = new Map<string, BrowserTab>();
  private readonly idleMs: number;

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(DATA_DIR) private readonly dataDir: string,
    @Inject(BROWSER_OPTIONS) private readonly options: BrowserOptions,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  }

  async onModuleInit(): Promise<void> {
    this.sessions.onRemoved((id) => this.dropSession(id));
    await killOrphanChromes(this.dataDir);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.slots.values()].map((slot) => this.stop(slot)));
  }

  chrome(): ChromeState {
    return findChrome(this.options.chromePath) ? ChromeState.Ready : ChromeState.Missing;
  }

  /** The Session kinds that have a browser. */
  offers(sessionId: string): boolean {
    const { kind } = this.sessions.get(sessionId);
    return (kind === SessionKind.Repo || kind === SessionKind.Anonymous) && this.chrome() === ChromeState.Ready;
  }

  state(sessionId: string): BrowserState {
    this.requireKind(sessionId);
    return { chrome: this.chrome(), tabs: (this.slots.get(sessionId)?.tabs ?? []).map((tab) => tab.snapshot()) };
  }

  private requireKind(sessionId: string): void {
    const { kind } = this.sessions.get(sessionId);
    if (kind !== SessionKind.Repo && kind !== SessionKind.Anonymous) {
      throw new ApiError(409, ErrorCode.BrowserNotAvailable, 'This Session has no browser');
    }
  }

  /** A tab by id, for a caller that holds only the id. Throws for an unknown one. */
  tab(tabId: string): BrowserTab {
    const tab = this.byId.get(tabId);
    if (!tab) throw new ApiError(404, ErrorCode.NotFound, 'no such tab');
    return tab;
  }

  known(tabId: string): boolean {
    return this.byId.has(tabId);
  }

  /** The Session's tabs in the order they opened. */
  tabsOf(sessionId: string): BrowserTab[] {
    return [...(this.slots.get(sessionId)?.tabs ?? [])];
  }

  private live(tabId: string): BrowserTab {
    const tab = this.tab(tabId);
    if (tab.dead)
      throw new ApiError(409, ErrorCode.BrowserNotAvailable, 'Chrome stopped. Close this tab and open a new one.');
    this.touch(this.slotOf(tab));
    return tab;
  }

  private slotOf(tab: BrowserTab): Slot {
    const slot = this.slots.get(tab.state.session_id);
    if (!slot) throw new ApiError(404, ErrorCode.NotFound, 'no such tab');
    return slot;
  }

  /** The tab as the operator's address field would open it: any http or https address. */
  async openAddress(sessionId: string, input: string | undefined): Promise<BrowserTab> {
    const address = input === undefined ? null : normalizeAddress(input);
    if (input !== undefined && address === null) {
      throw new ApiError(422, ErrorCode.UrlNotAllowed, 'Only http and https addresses open here');
    }
    const tab = await this.openTab(sessionId, TabOpener.Operator);
    if (address) void tab.load(address);
    return tab;
  }

  /** A new blank tab, starting the Session's Chrome when none runs. */
  async openTab(sessionId: string, openedBy: TabOpener): Promise<BrowserTab> {
    this.requireKind(sessionId);
    if (this.chrome() === ChromeState.Missing) {
      throw new ApiError(
        503,
        ErrorCode.ChromeMissing,
        'Google Chrome is needed. Install it, or set OPS_CONSOLE_CHROME_PATH.',
      );
    }
    const slot = await this.slotFor(sessionId);
    slot.context ??= this.launch(slot);
    const context = await slot.context;
    const page = slot.spare ?? (await context.newPage());
    slot.spare = undefined;
    return this.adopt(slot, context, page, openedBy);
  }

  private async slotFor(sessionId: string): Promise<Slot> {
    let slot = this.slots.get(sessionId);
    // A Chrome on its way out still holds the profile folder.
    while (slot?.stopping) {
      await slot.stopping;
      slot = this.slots.get(sessionId);
    }
    if (slot) return slot;
    const fresh: Slot = {
      sessionId,
      profile: path.join(this.dataDir, 'browser', sessionId),
      context: null,
      spare: undefined,
      tabs: [],
      idle: undefined,
      titles: undefined,
      stopping: null,
      crashed: false,
    };
    this.slots.set(sessionId, fresh);
    return fresh;
  }

  private launch(slot: Slot): Promise<BrowserContext> {
    return chromium
      .launchPersistentContext(slot.profile, {
        executablePath: findChrome(this.options.chromePath) ?? undefined,
        headless: true,
        acceptDownloads: false,
        viewport: null,
        args: LAUNCH_ARGS,
      })
      .then((context) => {
        slot.crashed = false;
        slot.spare = context.pages()[0];
        context.on('close', () => this.onChromeExit(slot));
        return context;
      })
      .catch((error: unknown) => {
        slot.context = null;
        if (slot.tabs.length === 0) this.slots.delete(slot.sessionId);
        const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];
        throw new ApiError(503, ErrorCode.ChromeMissing, `Chrome did not start: ${reason}`);
      });
  }

  private readonly hooks: TabHooks = {
    changed: (sessionId) => this.store.emit('browser.tabs_changed', { session_id: sessionId }),
    closed: (tab, requested) => {
      // Chrome announces its pages closing, then itself; wait for the second to tell a crash from `window.close()`.
      if (requested) this.remove(tab);
      else
        setImmediate(() =>
          this.slots.get(tab.state.session_id)?.crashed ? tab.die(CHROME_STOPPED) : this.remove(tab),
        );
    },
    popup: (opener, page) => {
      const slot = this.slots.get(opener.state.session_id);
      const context = page.context();
      // A popup that closes before it is adopted needs no tab.
      if (slot) void this.adopt(slot, context, page, TabOpener.Operator).catch(() => {});
    },
  };

  private async adopt(slot: Slot, context: BrowserContext, page: Page, openedBy: TabOpener): Promise<BrowserTab> {
    const tab = await BrowserTab.open(context, page, slot.sessionId, openedBy, this.hooks);
    slot.tabs.push(tab);
    this.byId.set(tab.id, tab);
    this.touch(slot);
    this.hooks.changed(slot.sessionId);
    return tab;
  }

  private remove(tab: BrowserTab): void {
    const slot = this.slots.get(tab.state.session_id);
    if (!this.byId.delete(tab.id) || !slot) return;
    slot.tabs = slot.tabs.filter((t) => t !== tab);
    tab.closeViewers();
    this.hooks.changed(slot.sessionId);
    // Chrome stays for the next tab until the idle time ends it.
    if (slot.tabs.length === 0 && !slot.stopping) this.touch(slot);
    this.pollTitles(slot);
  }

  /** A page can change its own title, and nothing announces it: tabs are read on a timer while a viewer is attached. */
  private pollTitles(slot: Slot): void {
    const watched = slot.tabs.some((tab) => tab.viewers.size > 0);
    if (watched && !slot.titles) {
      slot.titles = setInterval(() => {
        for (const tab of slot.tabs) void tab.pollTitle();
      }, TITLE_POLL_MS);
      slot.titles.unref();
    } else if (!watched && slot.titles) {
      clearInterval(slot.titles);
      slot.titles = undefined;
    }
  }

  private onChromeExit(slot: Slot): void {
    if (slot.stopping) return;
    slot.crashed = true;
    slot.context = null;
    slot.spare = undefined;
    clearInterval(slot.titles);
    slot.titles = undefined;
    for (const tab of slot.tabs) tab.die(CHROME_STOPPED);
  }

  /** Closes the Session's Chrome and drops its tabs; the profile folder stays. */
  private stop(slot: Slot): Promise<void> {
    slot.stopping ??= (async () => {
      clearTimeout(slot.idle);
      clearInterval(slot.titles);
      for (const tab of slot.tabs) tab.closing = true;
      try {
        const context = await slot.context?.catch(() => null);
        await context?.close().catch(() => {});
      } finally {
        for (const tab of [...slot.tabs]) this.remove(tab);
        this.slots.delete(slot.sessionId);
      }
    })();
    return slot.stopping;
  }

  /** Counts as activity: restarts the idle clock. */
  private touch(slot: Slot): void {
    clearTimeout(slot.idle);
    slot.idle = setTimeout(() => {
      const watched = slot.tabs.some((tab) => tab.viewers.size > 0 || tab.agentBusy);
      if (watched) this.touch(slot);
      else void this.stop(slot);
    }, this.idleMs);
    slot.idle.unref();
  }

  /** Marks activity on a Session's Chrome, for the agent's calls. */
  activity(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (slot) this.touch(slot);
  }

  // REST

  async patch(tabId: string, body: PatchTabBody): Promise<BrowserTab> {
    const tab = this.live(tabId);
    if (body.viewport) await tab.setViewport(body.viewport);
    if (body.url !== undefined) {
      const address = normalizeAddress(body.url);
      if (!address) throw new ApiError(422, ErrorCode.UrlNotAllowed, 'Only http and https addresses open here');
      void tab.load(address);
    }
    if (body.action) await tab.act(body.action);
    return tab;
  }

  async stageFile(tabId: string, name: string, body: Readable): Promise<StagedFile> {
    return this.live(tabId).stageFile(name, body);
  }

  async chooseFiles(tabId: string, ids: string[]): Promise<void> {
    await this.live(tabId).chooseFiles(ids);
  }

  async close(tabId: string): Promise<void> {
    const tab = this.tab(tabId);
    if (tab.dead) return this.remove(tab);
    tab.closing = true;
    await tab.page.close();
  }

  async openExternal(tabId: string): Promise<void> {
    const { url } = this.tab(tabId).state;
    if (!url) throw new ApiError(409, ErrorCode.NothingLoaded, 'This tab has no page loaded');
    if (!/^https?:\/\//.test(url))
      throw new ApiError(422, ErrorCode.UrlNotAllowed, 'Only http and https addresses open outside');
    await (this.options.openExternal ?? openInDefaultBrowser)(url);
  }

  /** Closes the Session's Chrome and deletes its cookies and storage. */
  async clear(sessionId: string): Promise<void> {
    this.requireKind(sessionId);
    await this.dropSession(sessionId);
  }

  private async dropSession(sessionId: string): Promise<void> {
    const slot = this.slots.get(sessionId);
    if (slot) await this.stop(slot);
    await rm(path.join(this.dataDir, 'browser', sessionId), { recursive: true, force: true });
  }

  // Stream

  async attach(tabId: string, viewer: WebSocket): Promise<void> {
    const tab = this.live(tabId);
    const slot = this.slotOf(tab);
    // The viewer joins the tab at once; the title poll must not wait for the first frame to be taken.
    const attaching = tab.attach(viewer);
    this.pollTitles(slot);
    await attaching;
  }

  async detach(tabId: string, viewer: WebSocket): Promise<void> {
    const tab = this.byId.get(tabId);
    if (!tab) return;
    await tab.detach(viewer);
    const slot = this.slots.get(tab.state.session_id);
    if (slot) {
      this.touch(slot);
      this.pollTitles(slot);
    }
  }

  async input(tabId: string, viewer: WebSocket, message: BrowserClientMessage): Promise<void> {
    await this.live(tabId).input(viewer, message);
  }
}
