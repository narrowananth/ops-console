import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { terminalClientMessageSchema, WS_PROTOCOL } from '@ops-console/shared';
import { WebSocketServer } from 'ws';
import { WsHub } from '../common/ws-hub';
import { TerminalsService } from './terminals.service';

/** `/terminals/:id`: a raw stream to one terminal, behind the same token as `/ws`. */
@Injectable()
export class TerminalGateway implements OnModuleInit {
  private readonly server = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });

  constructor(
    @Inject(WsHub) private readonly hub: WsHub,
    @Inject(TerminalsService) private readonly terminals: TerminalsService,
  ) {}

  onModuleInit(): void {
    this.hub.route(/^\/terminals\/([^/]+)$/, (match, request, socket, head) => {
      const id = match[1] ?? '';
      if (!this.terminals.has(id)) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      this.server.handleUpgrade(request, socket, head, (client) => {
        this.terminals.attach(id, client);
        client.on('message', (raw) => {
          try {
            const message = terminalClientMessageSchema.parse(JSON.parse(String(raw)));
            if (message.type === 'input') this.terminals.input(id, message.data);
            else if (message.type === 'line') this.terminals.line(id, message.text);
            else this.terminals.resize(id, message.cols, message.rows);
          } catch {
            // A message that is not valid, or for a terminal that ended, is dropped.
          }
        });
      });
    });
  }

  onModuleDestroy(): void {
    for (const client of this.server.clients) client.terminate();
    this.server.close();
  }
}
