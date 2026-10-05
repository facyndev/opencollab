import { OnModuleInit } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { RawData, Server as WsServer, WebSocket } from 'ws';

import { replyForTextFrame } from './protocol';

/**
 * Collaboration socket. Parity with the axum stub: raw text frames carrying an
 * `Envelope` echo back when compatible; anything else gets an error frame.
 * Binary frames are ignored (the Rust side `continue`s past them too).
 *
 * Frames are handled RAW on purpose: the `ws` adapter's `@SubscribeMessage`
 * routing expects `{ event, data }` payloads, which is NOT our wire format.
 */
// TODO: autenticar, enrutar por sesión y filtrar por permiso vigente.
@WebSocketGateway({ path: '/ws' })
export class CollabGateway implements OnModuleInit {
  @WebSocketServer()
  private server!: WsServer;

  onModuleInit(): void {
    this.server.on('connection', (socket: WebSocket) => {
      socket.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          return;
        }
        const frame = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
        const text = frame.toString('utf8');
        socket.send(replyForTextFrame(text));
      });
    });
  }
}
