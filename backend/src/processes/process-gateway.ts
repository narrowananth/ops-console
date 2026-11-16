import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { processClientMessageSchema, WS_PROTOCOL } from '@ops-console/shared';
import { WebSocketServer } from 'ws';
import { WsHub } from '../common/ws-hub';
import { ProcessesService } from './processes.service';

/** `/processes/:id`: a raw stream to one Session process, behind the same token as `/ws`. */
@Injectable()
export class ProcessGateway implements OnModuleInit, OnModuleDestroy {
  private readonly server = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });

  constructor(
    @Inject(WsHub) private readonly hub: WsHub,
    @Inject(ProcessesService) private readonly processes: ProcessesService,
  ) {}

  onModuleInit(): void {
    this.hub.route(/^\/processes\/([^/]+)$/, (match, request, socket, head) => {
      const id = match[1] ?? '';
      if (!this.processes.has(id)) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      this.server.handleUpgrade(request, socket, head, (client) => {
        client.on('error', () => {});
        this.processes.attach(id, client);
        client.on('message', (raw) => {
          try {
            const message = processClientMessageSchema.parse(JSON.parse(String(raw)));
            if (message.type === 'input') this.processes.write(id, message.data);
            else this.processes.resize(id, message.cols, message.rows);
          } catch {
            // A message that is not valid, or for a process that ended, is dropped.
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
