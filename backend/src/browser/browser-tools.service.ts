import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode, TabOpener } from '@ops-console/shared';
import type { Page } from 'playwright-core';
import { redact } from '../action-log/redact';
import { AgentRuntime } from '../agent/runtime';
import { ApiError, validationFailed } from '../common/errors';
import { agentMayOpen, isConsolePort, isLoopbackHost } from './addresses';
import { BrowserService } from './browser.service';
import type { BrowserTab } from './browser-tab';

const MAX_ENTRIES = 200;
/** Cap on text handed back to the agent: a script result or a page snapshot. */
const MAX_RESULT = 100_000;
const ACTION_TIMEOUT = 10_000;
const LOAD_TIMEOUT = 30_000;

export type PageStatus = { tab_id: string; url: string; title: string };

const cap = (text: string): string => (text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n[truncated]` : text);

/** Why the agent may not touch this address, or null when it may. Blank tabs are fine. */
function refusal(address: string): string | null {
  if (!address) return null;
  if (agentMayOpen(address)) return null;
  const url = URL.canParse(address) ? new URL(address) : null;
  if (url && isLoopbackHost(url.hostname) && isConsolePort(Number(url.port))) {
    return `This tab is on the console's own port :${url.port}. Agent tools do not work on the console.`;
  }
  return `This tab is on ${url?.hostname || address}. Agent tools work on loopback pages.`;
}

/**
 * What the agent's browser tools call. Each takes the Session id, acts on one of the Session's tabs (the agent's own,
 * else the first) and works only on a loopback page that is not one of the console's own.
 */
@Injectable()
export class BrowserToolsService {
  constructor(
    @Inject(BrowserService) private readonly browser: BrowserService,
    @Inject(AgentRuntime) runtime: AgentRuntime,
  ) {
    runtime.setBrowserTools(this);
  }

  /** True when the Session has a browser and Chrome is installed: the lead registers the tools only then. */
  offers(sessionId: string): boolean {
    return this.browser.offers(sessionId);
  }

  /** The Approval text for `browser_evaluate`. */
  describeEvaluate(script: string): string {
    return `Run this script in the Session's browser page:\n${script.length > 4000 ? `${script.slice(0, 4000)}…` : script}`;
  }

  /** Opens a loopback address in the given tab, else the agent's tab, else a new one; waits for the page to load. */
  async open(sessionId: string, url: string, tabId?: string): Promise<PageStatus & { error: string | null }> {
    if (!agentMayOpen(url)) {
      throw new ApiError(
        422,
        ErrorCode.UrlNotAllowed,
        "The agent opens only http or https pages on localhost, 127.0.0.1 or [::1], and not the console's own ports (4545, 4555, 4556).",
      );
    }
    const tab = tabId ? this.tab(sessionId, tabId) : await this.agentTab(sessionId);
    this.check(tab);
    tab.markOpenedBy(TabOpener.Agent);
    const error = await this.acting(tab, () => tab.load(url, LOAD_TIMEOUT));
    await this.leaveIfRefused(tab);
    return { ...this.status(tab), error };
  }

  /** The page as an accessibility tree: one line per element, a `[ref=eN]` on each one that can be acted on. */
  async snapshot(sessionId: string, tabId?: string): Promise<PageStatus & { snapshot: string }> {
    return this.run(sessionId, tabId, async (tab, page) => ({
      ...this.status(tab),
      snapshot: cap(await page.ariaSnapshot({ mode: 'ai' })),
    }));
  }

  async screenshot(sessionId: string, tabId?: string): Promise<{ mimeType: 'image/png'; base64: string }> {
    return this.run(sessionId, tabId, async (tab) => ({
      mimeType: 'image/png' as const,
      base64: await tab.capture('png'),
    }));
  }

  async click(sessionId: string, ref: string, tabId?: string): Promise<PageStatus> {
    return this.run(sessionId, tabId, async (tab, page) => {
      await page.locator(`aria-ref=${checkRef(ref)}`).click({ timeout: ACTION_TIMEOUT });
      return this.status(tab);
    });
  }

  async type(sessionId: string, ref: string, text: string, submit = false, tabId?: string): Promise<PageStatus> {
    return this.run(sessionId, tabId, async (tab, page) => {
      const element = page.locator(`aria-ref=${checkRef(ref)}`);
      await element.fill(text, { timeout: ACTION_TIMEOUT });
      if (submit) await element.press('Enter', { timeout: ACTION_TIMEOUT });
      return this.status(tab);
    });
  }

  async press(sessionId: string, key: string, tabId?: string): Promise<PageStatus> {
    return this.run(sessionId, tabId, async (tab, page) => {
      await page.keyboard.press(key);
      return this.status(tab);
    });
  }

  async scroll(sessionId: string, dx: number, dy: number, tabId?: string): Promise<PageStatus> {
    return this.run(sessionId, tabId, async (tab, page) => {
      await page.mouse.wheel(dx, dy);
      return this.status(tab);
    });
  }

  /** Runs an expression or function in the page; answers its JSON, cut at 100 KB. */
  async evaluate(sessionId: string, script: string, tabId?: string): Promise<string> {
    return this.run(sessionId, tabId, async (_tab, page) =>
      cap(JSON.stringify(await page.evaluate(script)) ?? 'undefined'),
    );
  }

  async consoleEntries(sessionId: string, n: number, tabId?: string): Promise<{ type: string; text: string }[]> {
    return this.run(sessionId, tabId, async (tab) =>
      tab.consoleEntries.slice(-count(n)).map((entry) => ({ type: entry.type, text: redact(entry.text) })),
    );
  }

  async networkEntries(
    sessionId: string,
    n: number,
    tabId?: string,
  ): Promise<{ method: string; url: string; status: number | null }[]> {
    return this.run(sessionId, tabId, async (tab) =>
      tab.networkEntries.slice(-count(n)).map((entry) => ({ ...entry, url: redact(entry.url) })),
    );
  }

  // Tab choice and the loopback check

  private tab(sessionId: string, tabId: string): BrowserTab {
    const tab = this.browser.tab(tabId);
    if (tab.state.session_id !== sessionId) throw new ApiError(404, ErrorCode.NotFound, 'no such tab');
    return tab;
  }

  /** The agent's own tab, else a new one. */
  private async agentTab(sessionId: string): Promise<BrowserTab> {
    const own = this.browser.tabsOf(sessionId).find((t) => t.state.opened_by === TabOpener.Agent && !t.dead);
    return own && refusal(own.state.url) === null ? own : this.browser.openTab(sessionId, TabOpener.Agent);
  }

  private pick(sessionId: string, tabId: string | undefined): BrowserTab {
    if (tabId) return this.tab(sessionId, tabId);
    const tabs = this.browser.tabsOf(sessionId).filter((t) => !t.dead);
    const tab = tabs.find((t) => t.state.opened_by === TabOpener.Agent) ?? tabs[0];
    if (!tab) throw new ApiError(404, ErrorCode.NotFound, 'No tab is open. Open one with browser_open first.');
    return tab;
  }

  private check(tab: BrowserTab): void {
    if (tab.dead) throw new ApiError(409, ErrorCode.BrowserNotAvailable, 'Chrome stopped. Open the page again.');
    const reason = refusal(tab.state.url);
    if (reason) throw new ApiError(422, ErrorCode.UrlNotAllowed, reason);
  }

  private status(tab: BrowserTab): PageStatus {
    return { tab_id: tab.id, url: tab.state.url, title: tab.state.title };
  }

  private async acting<T>(tab: BrowserTab, work: () => Promise<T>): Promise<T> {
    this.browser.activity(tab.state.session_id);
    try {
      const done = await tab.asAgent(work);
      await this.leaveIfRefused(tab);
      return done;
    } finally {
      this.browser.activity(tab.state.session_id);
    }
  }

  /** A loopback page may redirect or link off loopback; the agent is told and the tab goes blank (Behavior 22). */
  private async leaveIfRefused(tab: BrowserTab): Promise<void> {
    const reason = refusal(tab.state.url);
    if (!reason) return;
    await tab.page.goto('about:blank').catch(() => {});
    throw new ApiError(422, ErrorCode.UrlNotAllowed, reason);
  }

  private run<T>(
    sessionId: string,
    tabId: string | undefined,
    work: (tab: BrowserTab, page: Page) => Promise<T>,
  ): Promise<T> {
    const tab = this.pick(sessionId, tabId);
    this.check(tab);
    return this.acting(tab, () => work(tab, tab.page));
  }
}

const count = (n: number): number => Math.max(1, Math.min(MAX_ENTRIES, Math.trunc(n)));

function checkRef(ref: string): string {
  if (!/^[a-z]*\d+(e\d+)?$/i.test(ref)) throw validationFailed('ref is not one from browser_snapshot');
  return ref;
}
