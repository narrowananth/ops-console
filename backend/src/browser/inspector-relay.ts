import type { CDPSession } from 'playwright-core';
import { WebSocket } from 'ws';
import { z } from 'zod';

/** CDP domains the Inspector window may use whole. They read and change the page's own state, as its DevTools do. */
const ALLOWED_DOMAINS = new Set([
  'DOM',
  'CSS',
  'Overlay',
  'Runtime',
  'Log',
  'Network',
  'Debugger',
  'Profiler',
  'HeapProfiler',
  'DOMDebugger',
  'DOMStorage',
  'IndexedDB',
  'CacheStorage',
  'ServiceWorker',
  'Storage',
  'Audits',
  'Inspector',
  'Memory',
  'Accessibility',
  'Media',
  'PerformanceTimeline',
  'Performance',
  // Animations drawer; Speculative loads in Application; streams that carry source maps and large bodies.
  'Animation',
  'Preload',
  'IO',
]);

/**
 * The rest of what DevTools asks of the page. `Page` has only these: it navigates, resizes and streams the tab, which
 * the panel owns. `Page.reload` reloads the address the panel's own Reload loads. `Target.getTargetInfo` answers for the
 * page itself.
 */
const ALLOWED_METHODS = new Set([
  'Page.enable',
  'Page.disable',
  'Page.getResourceTree',
  'Page.getFrameTree',
  'Page.getResourceContent',
  'Page.searchInResource',
  'Page.getAppManifest',
  'Page.getInstallabilityErrors',
  'Page.getManifestIcons',
  'Page.getAppId',
  'Page.getLayoutMetrics',
  'Page.getNavigationHistory',
  'Page.getOriginTrials',
  'Page.setLifecycleEventsEnabled',
  'Page.getSubApps',
  'Page.getSiblingSubApps',
  'Page.reload',
  // The Security panel's events. Every other `Security` method changes how Chrome treats certificates.
  'Security.enable',
  'Security.disable',
  'Target.getTargetInfo',
]);

/** In an allowed domain, but a way out of what the operator sees: the page would read any file on this Mac, or requests would stall. */
const REFUSED_METHODS = new Set(['DOM.setFileInputFiles', 'Network.setRequestInterception']);

/**
 * Answered here with an empty result and never sent on. Child targets (frames in other processes, workers) need a
 * session of their own that this relay cannot give, and `Target.setAutoAttach` would also pause them for a debugger.
 */
const ACKNOWLEDGED_METHODS = new Set(['Target.setAutoAttach', 'Target.setDiscoverTargets']);

export type Verdict = 'forward' | 'acknowledge' | 'refuse';

/** What the relay does with a method: DevTools' own domains go to the page, the rest is refused. */
export function verdict(method: string): Verdict {
  if (ACKNOWLEDGED_METHODS.has(method)) return 'acknowledge';
  if (REFUSED_METHODS.has(method)) return 'refuse';
  if (ALLOWED_METHODS.has(method)) return 'forward';
  return ALLOWED_DOMAINS.has(method.split('.')[0] ?? '') ? 'forward' : 'refuse';
}

const requestSchema = z.object({
  id: z.number().int(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().optional(),
});

const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const SERVER_ERROR = -32000;

/** Chrome's message without Playwright's "cdpSession.send: Protocol error (Method.name): " lead, which DevTools would show twice. */
const chromeMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^(cdpSession\.send: )?Protocol error \([^)]*\): /,
    '',
  );

/**
 * One Inspector window's line to a tab: DevTools' CDP messages in, the page's replies and events out, through a CDP
 * session of its own. The relay forwards only what `verdict` allows. Closing it detaches the session, which lifts any
 * pause the window held on the page.
 */
export class InspectorRelay {
  private closed = false;

  /**
   * DevTools sends its first request the moment the socket opens, before Chrome has made the session: `session` is
   * the session on its way, and a request waits for it.
   */
  constructor(
    private readonly session: Promise<CDPSession>,
    private readonly socket: WebSocket,
    private readonly onClosed: (relay: InspectorRelay) => void,
  ) {
    socket.on('message', (raw) => void this.receive(String(raw)));
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
    session.then(
      (cdp) => {
        cdp.on('event', ({ method, params }) => this.send({ method, params }));
        cdp.on('close', () => this.close(1000, 'tab_closed'));
        // Closed while the session was being made.
        if (this.closed) void cdp.detach().catch(() => {});
      },
      () => this.close(1011, 'tab_unavailable'),
    );
  }

  close(code = 1000, reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(code, reason);
    }
    void this.session.then((cdp) => cdp.detach()).catch(() => {});
    this.onClosed(this);
  }

  private send(message: object): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private async receive(text: string): Promise<void> {
    const parsed = requestSchema.safeParse(parseJson(text));
    if (!parsed.success) {
      this.send({ error: { code: INVALID_REQUEST, message: 'Not a DevTools protocol request' } });
      return;
    }
    const { id, method, params, sessionId } = parsed.data;
    if (sessionId !== undefined) {
      this.send({ id, error: { code: INVALID_REQUEST, message: 'This window has no child targets' } });
      return;
    }
    const decision = verdict(method);
    if (decision === 'refuse') {
      this.send({ id, error: { code: METHOD_NOT_FOUND, message: `Ops Console does not allow ${method} here` } });
      return;
    }
    if (decision === 'acknowledge') {
      this.send({ id, result: {} });
      return;
    }
    try {
      // The method is checked above; the protocol's own types name only the methods Playwright knows.
      const cdp = await this.session;
      const result = await cdp.send(method as never, params as never);
      this.send({ id, result });
    } catch (error) {
      this.send({ id, error: { code: SERVER_ERROR, message: chromeMessage(error) } });
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
