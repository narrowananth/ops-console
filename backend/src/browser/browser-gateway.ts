import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { browserClientMessageSchema, WS_PROTOCOL } from '@ops-console/shared';
import { WebSocketServer } from 'ws';
import { WsHub } from '../common/ws-hub';
import { BrowserService } from './browser.service';

const REFUSALS = { 404: 'Not Found', 409: 'Conflict', 429: 'Too Many Requests' } as const;

/** `/browser/:tabId`: the page's frames to the panel and the panel's input back, behind the same token as `/ws`. */
@Injectable()
export class BrowserGateway implements OnModuleInit, OnModuleDestroy {
  private readonly server = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });

  constructor(
    @Inject(WsHub) private readonly hub: WsHub,
    @Inject(BrowserService) private readonly browser: BrowserService,
  ) {}

  /** The Inspector windows' sockets: DevTools' protocol to a tab, not the page stream. */
  private readonly inspectors = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });

  onModuleInit(): void {
    this.hub.route(/^\/browser\/([^/]+)\/devtools$/, (match, request, socket, head) => {
      const id = match[1] ?? '';
      const refusal = this.browser.inspectorRefusal(id);
      if (refusal !== null) {
        socket.end(`HTTP/1.1 ${refusal} ${REFUSALS[refusal]}\r\nConnection: close\r\n\r\n`);
        return;
      }
      this.inspectors.handleUpgrade(request, socket, head, (window) => {
        window.on('error', () => {});
        try {
          this.browser.inspect(id, window);
        } catch {
          window.close(1011, 'tab_unavailable');
        }
      });
    });
    this.hub.route(/^\/browser\/([^/]+)$/, (match, request, socket, head) => {
      const id = match[1] ?? '';
      if (!this.browser.known(id)) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      this.server.handleUpgrade(request, socket, head, (client) => {
        client.on('error', () => {});
        client.on('close', () => void this.browser.detach(id, client));
        client.on('message', (raw) => {
          const parsed = browserClientMessageSchema.safeParse(parseJson(String(raw)));
          // A message that is not valid, or for a tab that closed, is dropped.
          if (parsed.success) void this.browser.input(id, client, parsed.data).catch(() => {});
        });
        void this.browser.attach(id, client).catch(() => client.close(1011, 'tab_unavailable'));
      });
    });
  }

  onModuleDestroy(): void {
    for (const client of [...this.server.clients, ...this.inspectors.clients]) client.terminate();
    this.server.close();
    this.inspectors.close();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
