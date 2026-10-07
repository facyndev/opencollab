import type { IncomingMessage } from 'node:http';

import { Inject, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { RawData, Server as WsServer, WebSocket } from 'ws';

import { SessionRevocations } from './auth/session-revocations';
import { SessionService, type AccessClaims } from './auth/session.service';
import { ConnectionDeadline } from './connection-deadline';
import { CLOSE_HANDSHAKE_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS, MAX_BUFFERED_BYTES } from './connection-policy';
import { SUBPROTOCOL, bearerFromProtocols } from './handshake';
import { SessionHub, type HubConnection } from './hub';

/** What the gateway tracks per open socket (heartbeat, family revocation, shutdown). */
interface Live {
  readonly socket: WebSocket;
  /** Refresh family of the token the connection currently runs on, if the token has one. */
  familyId: string | undefined;
  /** False from a ping until its pong arrives. */
  alive: boolean;
  /** Detaches from the hub and starts a close; terminates if the peer never completes it. */
  drop(code: number, reason: string): void;
  /** Detaches from the hub and kills the socket without a close handshake. */
  kill(): void;
}

/**
 * Collaboration socket: a thin adapter between `ws` and the hub.
 *
 * The upgrade is authenticated in `verifyClient` (access JWT in
 * `Sec-WebSocket-Protocol`), so an unauthenticated client never gets a socket.
 * The token is never logged. The socket lives only as long as the token: its
 * `exp` (plus a grace) is a deadline, moved later by an in-band `reauth`, and
 * revoking its refresh family closes it. A heartbeat reaps half-open sockets
 * and a consumer that cannot keep up is closed (never fed silently-dropped
 * terminal output). Frames are handled RAW on purpose: the `ws`
 * adapter's `@SubscribeMessage` routing expects `{ event, data }` payloads,
 * which is NOT our wire format. Binary frames are ignored.
 */
// 1 MiB: terminal output travels as JSON number arrays, so frames are chunky but bounded.
@WebSocketGateway({ path: '/ws', maxPayload: 1_048_576 })
export class CollabGateway implements OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  private server!: WsServer;

  /** Who each pending upgrade authenticated as, handed from verifyClient to `connection`. */
  private readonly authenticated = new WeakMap<IncomingMessage, AccessClaims>();
  private readonly connections = new Set<Live>();
  private readonly families = new Map<string, Set<Live>>();
  private heartbeat: NodeJS.Timeout | undefined;
  private unsubscribeRevocations: (() => void) | undefined;

  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(SessionHub) private readonly hub: SessionHub,
    @Inject(SessionRevocations) private readonly revocations: SessionRevocations,
  ) {}

  onModuleInit(): void {
    // Gateway decorator options are static and cannot see injected services,
    // so the hooks are attached here; `ws` reads them on every upgrade.
    this.server.options.verifyClient = (info, done) => {
      const token = bearerFromProtocols(info.req.headers['sec-websocket-protocol']);
      const claims = token === undefined ? undefined : this.sessions.verifyAccessClaims(token);
      if (claims === undefined) return done(false, 401, 'Unauthorized');
      this.authenticated.set(info.req, claims);
      done(true);
    };
    this.server.options.handleProtocols = () => SUBPROTOCOL;

    this.unsubscribeRevocations = this.revocations.subscribe((familyId) => {
      for (const live of [...(this.families.get(familyId) ?? [])]) live.drop(1008, 'session_revoked');
    });

    this.server.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      const auth = this.authenticated.get(request);
      if (auth === undefined) return socket.close(1008);
      this.accept(socket, auth);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribeRevocations?.();
    this.unsubscribeRevocations = undefined;
    this.stopHeartbeat();
  }

  private accept(socket: WebSocket, auth: AccessClaims): void {
    const { userId } = auth;
    let detached = false;
    let closeTimer: NodeJS.Timeout | undefined;
    const deadline = new ConnectionDeadline(() => live.drop(1008, 'token_expired'));

    // Idempotent: expiry, revocation, backpressure and the close event may race.
    const detach = (): void => {
      if (detached) return;
      detached = true;
      deadline.clear();
      this.hub.disconnect(conn);
      this.untrack(live);
    };

    let slow = false;
    const live: Live = {
      socket,
      familyId: auth.familyId,
      alive: true,
      drop: (code, reason) => {
        detach();
        socket.close(code, reason);
        if (closeTimer !== undefined || socket.readyState === socket.CLOSED) return;
        // A peer that never answers the close frame must not hold the socket open.
        closeTimer = setTimeout(() => socket.terminate(), CLOSE_HANDSHAKE_TIMEOUT_MS);
        closeTimer.unref?.();
      },
      kill: () => {
        detach();
        socket.terminate();
      },
    };

    const conn: HubConnection = {
      userId,
      send: (text) => {
        if (socket.readyState !== socket.OPEN) return;
        // Closing is loud; dropping terminal output would silently corrupt the viewer's terminal.
        if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
          // `send` runs inside the hub's broadcast loop: detaching here would mutate
          // the hub's connection set mid-iteration, so the drop waits for the loop to end.
          if (!slow) {
            slow = true;
            queueMicrotask(() => live.drop(1013, 'slow_consumer'));
          }
          return;
        }
        socket.send(text);
      },
      reauthenticate: (token) => {
        const claims = this.sessions.verifyAccessClaims(token);
        // Same user only: a token for someone else must not hijack this socket.
        if (claims === undefined || claims.userId !== userId) return undefined;
        const effective = deadline.extend(claims.expiresAt);
        // Family and deadline must come from the same token: adopt the family only
        // when this token is the one that now defines the deadline.
        if (effective === claims.expiresAt) this.setFamily(live, claims.familyId);
        return effective;
      },
    };

    this.hub.connect(conn);
    this.track(live);
    deadline.extend(auth.expiresAt);
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      // `receive` never rejects, so there is no unhandled promise to leak.
      void this.hub.receive(conn, toText(data));
    });
    socket.on('pong', () => {
      live.alive = true;
    });
    // Without a listener an `error` event (e.g. an oversized frame) would crash the process.
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (closeTimer !== undefined) clearTimeout(closeTimer);
      detach();
    });
  }

  private track(live: Live): void {
    this.connections.add(live);
    this.addToFamily(live);
    // Started on demand so an idle gateway holds no timer.
    this.heartbeat ??= setInterval(() => this.beat(), HEARTBEAT_INTERVAL_MS);
  }

  private untrack(live: Live): void {
    this.connections.delete(live);
    this.removeFromFamily(live);
    if (this.connections.size === 0) this.stopHeartbeat();
  }

  private setFamily(live: Live, familyId: string | undefined): void {
    if (live.familyId === familyId) return;
    this.removeFromFamily(live);
    live.familyId = familyId;
    this.addToFamily(live);
  }

  private addToFamily(live: Live): void {
    if (live.familyId === undefined) return;
    const set = this.families.get(live.familyId) ?? new Set<Live>();
    set.add(live);
    this.families.set(live.familyId, set);
  }

  private removeFromFamily(live: Live): void {
    if (live.familyId === undefined) return;
    const set = this.families.get(live.familyId);
    set?.delete(live);
    if (set?.size === 0) this.families.delete(live.familyId);
  }

  /** One tick: reap whoever missed the previous ping, ping everyone else. */
  private beat(): void {
    for (const live of [...this.connections]) {
      if (!live.alive) {
        live.kill();
        continue;
      }
      live.alive = false;
      try {
        live.socket.ping();
      } catch {
        // The socket's own close event removes it.
      }
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

function toText(data: RawData): string {
  const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
  return frame.toString('utf8');
}
