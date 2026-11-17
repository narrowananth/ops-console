import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WS_PATH, WS_PROTOCOL, type WsEvent } from '@ops-console/shared';
import { WebSocket, WebSocketServer } from 'ws';
import type { Session } from './session';

/** `/ws`: server-to-client events. The token rides as the second subprotocol so it stays out of URLs. */
/** An extra socket path with its own protocol, behind the same token check. */
type UpgradeRoute = {
  pattern: RegExp;
  handle(match: RegExpExecArray, request: IncomingMessage, socket: Duplex, head: Buffer): void;
};

/** A client with more than this queued to send is slow: it gets the newest `session.output` of each part, not each one. */
const SLOW_CLIENT_BYTES = 1024 * 1024;
const SLOW_CHECK_MS = 250;

/** Events that carry a whole part: a newer one for the same part replaces an older one that has not gone out. */
function replaceKey(event: WsEvent): string | null {
  return event.event === 'session.output'
    ? `${event.data.session_id}:${event.data.message_id}:${event.data.part_index}`
    : null;
}

export class WsHub {
  /** Per slow client, the newest event per key that waits for its queue to drain, in the order first held. */
  private readonly held = new Map<WebSocket, Map<string, string>>();
  private heldTimer: NodeJS.Timeout | null = null;
  private readonly routes: UpgradeRoute[] = [];
  private readonly listeners: ((event: WsEvent) => void)[] = [];

  private readonly server = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });

  constructor(private readonly session: Session) {}

  attach(http: Server): void {
    http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      const routed = this.routes.map((route) => ({ route, match: route.pattern.exec(pathname) })).find((r) => r.match);
      if (pathname !== WS_PATH && !routed) {
        socket.destroy();
        return;
      }
      const protocols = (request.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
      if (protocols[0] !== WS_PROTOCOL || !this.session.accepts(protocols[1])) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      if (routed?.match) {
        routed.route.handle(routed.match, request, socket, head);
        return;
      }
      this.server.handleUpgrade(request, socket, head, (client) => this.server.emit('connection', client, request));
    });
  }

  /** Hands upgrades for matching paths, once the token checks out, to `handle`. */
  route(pattern: RegExp, handle: UpgradeRoute['handle']): void {
    this.routes.push({ pattern, handle });
  }

  /** Called with every event as it goes out, for code that keeps what happened. */
  tap(listener: (event: WsEvent) => void): void {
    this.listeners.push(listener);
  }

  publish(event: WsEvent): void {
    for (const listener of this.listeners) listener(event);
    const message = JSON.stringify(event);
    const key = replaceKey(event);
    for (const client of this.server.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (key !== null && client.bufferedAmount > SLOW_CLIENT_BYTES) {
        this.hold(client, key, message);
        continue;
      }
      // What a slow client was held back goes first, so every client sees events in the order they happened.
      this.release(client);
      client.send(message);
    }
  }

  private hold(client: WebSocket, key: string, message: string): void {
    const events = this.held.get(client) ?? new Map<string, string>();
    events.set(key, message);
    this.held.set(client, events);
    this.heldTimer ??= setInterval(() => this.retryHeld(), SLOW_CHECK_MS);
    this.heldTimer.unref();
  }

  private release(client: WebSocket): void {
    const events = this.held.get(client);
    if (!events) return;
    this.held.delete(client);
    for (const message of events.values()) client.send(message);
  }

  /** Sends what a client was held back once its queue has drained; forgets a client that left. */
  private retryHeld(): void {
    for (const client of [...this.held.keys()]) {
      if (client.readyState !== WebSocket.OPEN) this.held.delete(client);
      else if (client.bufferedAmount <= SLOW_CLIENT_BYTES) this.release(client);
    }
    if (this.held.size === 0 && this.heldTimer) {
      clearInterval(this.heldTimer);
      this.heldTimer = null;
    }
  }

  close(): void {
    if (this.heldTimer) clearInterval(this.heldTimer);
    this.held.clear();
    for (const client of this.server.clients) client.terminate();
    this.server.close();
  }
}
