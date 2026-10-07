import type { IncomingMessage } from 'node:http';

import { Inject, OnModuleInit } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { RawData, Server as WsServer, WebSocket } from 'ws';

import { SessionService } from './auth/session.service';
import type { UserId } from './domain';
import { SUBPROTOCOL, bearerFromProtocols } from './handshake';
import { SessionHub, type HubConnection } from './hub';

/**
 * Collaboration socket: a thin adapter between `ws` and the hub.
 *
 * The upgrade is authenticated in `verifyClient` (access JWT in
 * `Sec-WebSocket-Protocol`), so an unauthenticated client never gets a socket.
 * The token is never logged. Frames are handled RAW on purpose: the `ws`
 * adapter's `@SubscribeMessage` routing expects `{ event, data }` payloads,
 * which is NOT our wire format. Binary frames are ignored.
 */
// 1 MiB: terminal output travels as JSON number arrays, so frames are chunky but bounded.
@WebSocketGateway({ path: '/ws', maxPayload: 1_048_576 })
export class CollabGateway implements OnModuleInit {
  @WebSocketServer()
  private server!: WsServer;

  /** Who each pending upgrade authenticated as, handed from verifyClient to `connection`. */
  private readonly authenticated = new WeakMap<IncomingMessage, UserId>();

  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(SessionHub) private readonly hub: SessionHub,
  ) {}

  onModuleInit(): void {
    // Gateway decorator options are static and cannot see injected services,
    // so the hooks are attached here; `ws` reads them on every upgrade.
    this.server.options.verifyClient = (info, done) => {
      const token = bearerFromProtocols(info.req.headers['sec-websocket-protocol']);
      const userId = token === undefined ? undefined : this.sessions.verifyAccess(token);
      if (userId === undefined) return done(false, 401, 'Unauthorized');
      this.authenticated.set(info.req, userId);
      done(true);
    };
    this.server.options.handleProtocols = () => SUBPROTOCOL;

    this.server.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      const userId = this.authenticated.get(request);
      if (userId === undefined) return socket.close(1008);
      const conn: HubConnection = {
        userId,
        send: (text) => {
          if (socket.readyState === socket.OPEN) socket.send(text);
        },
      };
      this.hub.connect(conn);
      socket.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) return;
        void this.hub.receive(conn, toText(data));
      });
      socket.on('close', () => this.hub.disconnect(conn));
    });
  }
}

function toText(data: RawData): string {
  const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
  return frame.toString('utf8');
}
