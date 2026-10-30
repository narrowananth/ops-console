import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WS_PATH, WS_PROTOCOL, type WsEvent } from '@ops-console/shared';
import { WebSocket, WebSocketServer } from 'ws';
import type { Session } from './session';

/** `/ws`: server-to-client events. The token rides as the second subprotocol so it stays out of URLs. */
export class WsHub {
  private readonly server = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });

  constructor(private readonly session: Session) {}

  attach(http: Server): void {
    http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(request.url ?? '/', 'http://localhost').pathname !== WS_PATH) {
        socket.destroy();
        return;
      }
      const protocols = (request.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
      if (protocols[0] !== WS_PROTOCOL || !this.session.accepts(protocols[1])) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      this.server.handleUpgrade(request, socket, head, (client) => this.server.emit('connection', client, request));
    });
  }

  publish(event: WsEvent): void {
    const message = JSON.stringify(event);
    for (const client of this.server.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  close(): void {
    for (const client of this.server.clients) client.terminate();
    this.server.close();
  }
}
