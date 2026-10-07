import type { AddressInfo, Socket } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { SessionRevocations } from './auth/session-revocations';
import { SessionService } from './auth/session.service';
import { CollabGateway } from './collab.gateway';
import { Session, Workspace, newAgentProfile, newUserId, type SessionId, type UserId } from './domain';
import { SESSION_STORE, SessionHub, type SessionStore } from './hub';
import { ConnectionDeadline, TOKEN_GRACE_MS } from './connection-deadline';
import {
  CLOSE_HANDSHAKE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_BUFFERED_BYTES,
} from './connection-policy';
import { FORBIDDEN, NOT_JOINED, UNAUTHORIZED } from './protocol';

const frame = (message: object): string => JSON.stringify({ version: 1, message });

describe('CollabGateway', () => {
  let app: INestApplication;
  let url: string;
  let owner: UserId;
  let member: UserId;
  let workspace: Workspace;
  let session: Session;
  let terminal: string;
  let tokens: Record<string, { userId: UserId; expiresAt: number; familyId?: string }>;
  let revocations: SessionRevocations;
  const open: WebSocket[] = [];

  beforeEach(async () => {
    owner = newUserId();
    member = newUserId();
    const farFuture = Math.floor(Date.now() / 1000) + 3600;
    tokens = {
      'owner-token': { userId: owner, expiresAt: farFuture },
      'member-token': { userId: member, expiresAt: farFuture },
    };
    workspace = new Workspace(owner, 'w');
    workspace.addMember(owner, member);
    session = Session.create(workspace, owner, 's');
    terminal = session.addTerminal(workspace, owner, newAgentProfile('sh', 'sh'));
    const store: SessionStore = {
      load: async (id: SessionId) => (id === session.id ? { session, workspace } : undefined),
      save: async () => undefined,
    };
    revocations = new SessionRevocations();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CollabGateway,
        { provide: SESSION_STORE, useValue: store },
        { provide: SessionHub, useFactory: (s: SessionStore) => new SessionHub(s), inject: [SESSION_STORE] },
        { provide: SessionService, useValue: { verifyAccessClaims: (t: string) => tokens[t] } },
        { provide: SessionRevocations, useValue: revocations },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0, '127.0.0.1');
    url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/ws`;
  });

  afterEach(async () => {
    for (const socket of open.splice(0)) socket.terminate();
    await app.close();
  });

  /** Resolves with the socket once open, or with the HTTP status of a rejected upgrade. */
  function connect(protocols?: string[], options?: WebSocket.ClientOptions): Promise<WebSocket | number> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, protocols, options);
      open.push(socket);
      socket.on('open', () => resolve(socket));
      socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      socket.on('error', (error) => {
        if (!/Unexpected server response/.test(String(error))) reject(error);
      });
    });
  }

  async function authed(token: string, options?: WebSocket.ClientOptions): Promise<WebSocket> {
    const socket = await connect(['opencollab.v1', `bearer.${token}`], options);
    if (typeof socket === 'number') throw new Error(`rejected with ${socket}`);
    return socket;
  }

  /** The server-side sockets, in connection order. */
  const serverSockets = (): WebSocket[] =>
    [...(app.get(CollabGateway) as unknown as { server: { clients: Set<WebSocket> } }).server.clients];

  /** Stops the client from reading, so it never answers a close frame or a ping. */
  const freeze = (socket: WebSocket): void =>
    void (socket as unknown as { _socket: Socket })._socket.pause();

  const next = (socket: WebSocket): Promise<string> =>
    new Promise((resolve) => socket.once('message', (data) => resolve(data.toString())));

  async function join(socket: WebSocket): Promise<string> {
    const reply = next(socket);
    socket.send(frame({ type: 'join_session', session_id: session.id }));
    return reply;
  }

  describe('handshake', () => {
    it('rejects the upgrade without credentials', async () => {
      expect(await connect()).toBe(401);
      expect(await connect(['opencollab.v1'])).toBe(401);
    });

    it('rejects an invalid token and a missing subprotocol', async () => {
      expect(await connect(['opencollab.v1', 'bearer.nope'])).toBe(401);
      expect(await connect(['bearer.owner-token'])).toBe(401);
    });

    it('accepts a valid token and selects opencollab.v1', async () => {
      const socket = await authed('owner-token');
      expect(socket.protocol).toBe('opencollab.v1');
    });
  });

  describe('routing over real sockets', () => {
    it('joins, fans owner output out to a viewer and drops it after view is revoked', async () => {
      const host = await authed('owner-token');
      const viewer = await authed('member-token');
      expect(JSON.parse(await join(host)).message.access).toBe('write');
      expect(JSON.parse(await join(viewer)).message.access).toBe('view');

      const out = frame({
        type: 'terminal_output',
        session_id: session.id,
        terminal_id: terminal,
        data: [104, 105],
      });
      const received = next(viewer);
      host.send(out);
      expect(await received).toBe(out);

      const change = frame({
        type: 'access_changed',
        session_id: session.id,
        user_id: member,
        access: 'none',
      });
      const told = next(viewer);
      host.send(change);
      expect(await told).toBe(change);

      // Revoked: the viewer is unsubscribed on the spot.
      const verdict = next(viewer);
      viewer.send(
        frame({
          type: 'terminal_input',
          session_id: session.id,
          terminal_id: terminal,
          user_id: member,
          data: [1],
        }),
      );
      expect(await verdict).toBe(NOT_JOINED);
    });

    it('answers forbidden for unknown sessions and ignores binary frames', async () => {
      const socket = await authed('member-token');
      socket.send(Buffer.from([1, 2, 3]), { binary: true });
      const reply = next(socket);
      socket.send(frame({ type: 'join_session', session_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }));
      expect(await reply).toBe(FORBIDDEN);
    });

    it('evicts the session when the last socket closes', async () => {
      const hub = app.get(SessionHub);
      const socket = await authed('owner-token');
      await join(socket);
      expect(hub.liveSessionCount()).toBe(1);
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close();
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(hub.liveSessionCount()).toBe(0);
    });
  });

  describe('token lifetime', () => {
    const nowSeconds = (): number => Math.floor(Date.now() / 1000);
    const closed = (socket: WebSocket): Promise<{ code: number; reason: string }> =>
      new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    // Only timeouts and the clock are faked (the heartbeat is tested apart): the sockets stay real.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });
    afterEach(() => vi.useRealTimers());

    const reauthFrame = (token: string): string => frame({ type: 'reauth', token });

    it('closes the socket with 1008 token_expired once the token expiry plus the grace passes', async () => {
      tokens['short'] = { userId: owner, expiresAt: nowSeconds() + 60 };
      const socket = await authed('short');
      const gone = closed(socket);
      vi.advanceTimersByTime(60_000 + TOKEN_GRACE_MS);
      expect(await gone).toEqual({ code: 1008, reason: 'token_expired' });
    });

    it('moves the deadline on reauth and answers reauthenticated with the new expiry', async () => {
      tokens['short'] = { userId: owner, expiresAt: nowSeconds() + 60 };
      const renewedAt = nowSeconds() + 900;
      tokens['renewed'] = { userId: owner, expiresAt: renewedAt };
      const socket = await authed('short');
      const reply = next(socket);
      socket.send(reauthFrame('renewed'));
      expect(JSON.parse(await reply)).toEqual({
        version: 1,
        message: { type: 'reauthenticated', expires_at: renewedAt },
      });

      let isClosed = false;
      socket.once('close', () => (isClosed = true));
      vi.advanceTimersByTime(60_000 + TOKEN_GRACE_MS);
      await new Promise((resolve) => setImmediate(resolve));
      expect(isClosed).toBe(false);

      const gone = closed(socket);
      vi.advanceTimersByTime(900_000);
      expect(await gone).toEqual({ code: 1008, reason: 'token_expired' });
    });

    it('refuses a token of another user without moving the deadline', async () => {
      tokens['short'] = { userId: owner, expiresAt: nowSeconds() + 60 };
      const socket = await authed('short');
      const reply = next(socket);
      socket.send(reauthFrame('member-token'));
      expect(await reply).toBe(UNAUTHORIZED);
      const gone = closed(socket);
      vi.advanceTimersByTime(60_000 + TOKEN_GRACE_MS);
      expect(await gone).toEqual({ code: 1008, reason: 'token_expired' });
    });

    it('refuses an invalid token and keeps the connection usable', async () => {
      const socket = await authed('owner-token');
      const reply = next(socket);
      socket.send(reauthFrame('nope'));
      expect(await reply).toBe(UNAUTHORIZED);
      expect(JSON.parse(await join(socket)).message.type).toBe('joined');
    });

    it('clears the deadline timer when the socket closes', async () => {
      const clear = vi.spyOn(ConnectionDeadline.prototype, 'clear');
      const socket = await authed('owner-token');
      clear.mockClear();
      const gone = closed(socket);
      socket.close();
      await gone;
      // The server's own close event can land a few ticks after the client's.
      for (let i = 0; i < 100 && clear.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(clear).toHaveBeenCalledOnce();
      clear.mockRestore();
    });

    it('detaches the connection from the hub the moment the token expires', async () => {
      tokens['short'] = { userId: owner, expiresAt: nowSeconds() + 60 };
      const hub = app.get(SessionHub);
      const socket = await authed('short');
      await join(socket);
      expect(hub.liveSessionCount()).toBe(1);
      freeze(socket); // never completes the close handshake
      vi.advanceTimersByTime(60_000 + TOKEN_GRACE_MS);
      // Synchronous: nothing may be routed to or from the socket after expiry.
      expect(hub.liveSessionCount()).toBe(0);
    });

    it('terminates a socket that does not complete the close handshake in time', async () => {
      tokens['short'] = { userId: owner, expiresAt: nowSeconds() + 60 };
      const socket = await authed('short');
      const [server] = serverSockets();
      const terminate = vi.spyOn(server as WebSocket, 'terminate');
      freeze(socket);
      vi.advanceTimersByTime(60_000 + TOKEN_GRACE_MS);
      expect(terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(CLOSE_HANDSHAKE_TIMEOUT_MS);
      expect(terminate).toHaveBeenCalledOnce();
    });

    it('does not terminate a socket whose close handshake completed', async () => {
      tokens['short'] = { userId: owner, expiresAt: nowSeconds() + 60 };
      const socket = await authed('short');
      const [server] = serverSockets();
      const terminate = vi.spyOn(server as WebSocket, 'terminate');
      const gone = closed(socket);
      vi.advanceTimersByTime(60_000 + TOKEN_GRACE_MS);
      await gone;
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
      vi.advanceTimersByTime(CLOSE_HANDSHAKE_TIMEOUT_MS * 2);
      expect(terminate).not.toHaveBeenCalled();
    });

    it('never shortens the deadline: reauth with an older, still valid token keeps the later expiry', async () => {
      const longAt = nowSeconds() + 900;
      tokens['long'] = { userId: owner, expiresAt: longAt };
      tokens['older'] = { userId: owner, expiresAt: nowSeconds() + 60 };
      const socket = await authed('long');
      const reply = next(socket);
      socket.send(reauthFrame('older'));
      expect(JSON.parse(await reply).message).toEqual({ type: 'reauthenticated', expires_at: longAt });

      let isClosed = false;
      socket.once('close', () => (isClosed = true));
      vi.advanceTimersByTime(60_000 + TOKEN_GRACE_MS);
      await new Promise((resolve) => setImmediate(resolve));
      expect(isClosed).toBe(false);
      const gone = closed(socket);
      vi.advanceTimersByTime(900_000);
      expect(await gone).toEqual({ code: 1008, reason: 'token_expired' });
    });
  });

  describe('refresh family revocation', () => {
    const closed = (socket: WebSocket): Promise<{ code: number; reason: string }> =>
      new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    const future = (): number => Math.floor(Date.now() / 1000) + 3600;

    it('closes only the sockets of the revoked family with 1008 session_revoked', async () => {
      tokens['a'] = { userId: owner, expiresAt: future(), familyId: 'fam-a' };
      tokens['b'] = { userId: owner, expiresAt: future(), familyId: 'fam-b' };
      const hub = app.get(SessionHub);
      const phone = await authed('a');
      const laptop = await authed('b');
      await join(phone);
      expect(hub.liveSessionCount()).toBe(1);

      const gone = closed(phone);
      revocations.publish('fam-a');
      expect(hub.liveSessionCount()).toBe(0); // detached on the spot
      expect(await gone).toEqual({ code: 1008, reason: 'session_revoked' });
      // The other device keeps working.
      expect(JSON.parse(await join(laptop)).message.type).toBe('joined');
    });

    it('moves a connection to the family of the token it renews with', async () => {
      tokens['a'] = { userId: owner, expiresAt: future(), familyId: 'fam-a' };
      tokens['a2'] = { userId: owner, expiresAt: future(), familyId: 'fam-b' };
      const socket = await authed('a');
      const reply = next(socket);
      socket.send(frame({ type: 'reauth', token: 'a2' }));
      expect(JSON.parse(await reply).message.type).toBe('reauthenticated');

      revocations.publish('fam-a'); // the old family no longer owns this socket
      expect(JSON.parse(await join(socket)).message.type).toBe('joined');
      const gone = closed(socket);
      revocations.publish('fam-b');
      expect(await gone).toEqual({ code: 1008, reason: 'session_revoked' });
    });

    it('keeps the family and the deadline of the token that lives longer when reauth presents an older one', async () => {
      tokens['long'] = { userId: owner, expiresAt: future() + 900, familyId: 'fam-long' };
      tokens['older'] = { userId: owner, expiresAt: future(), familyId: 'fam-older' };
      const socket = await authed('long');
      const reply = next(socket);
      socket.send(frame({ type: 'reauth', token: 'older' }));
      expect(JSON.parse(await reply).message.type).toBe('reauthenticated');

      // Family and deadline come from the same token: revoking the older family changes nothing...
      revocations.publish('fam-older');
      expect(JSON.parse(await join(socket)).message.type).toBe('joined');
      // ...while revoking the family of the token that defines the deadline still closes it.
      const gone = closed(socket);
      revocations.publish('fam-long');
      expect(await gone).toEqual({ code: 1008, reason: 'session_revoked' });
    });

    it('leaves sockets without a family untouched', async () => {
      const socket = await authed('owner-token'); // no familyId claim
      revocations.publish('fam-a');
      expect(JSON.parse(await join(socket)).message.type).toBe('joined');
    });
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    });
    afterEach(() => vi.useRealTimers());

    it('terminates and detaches a socket that does not answer a ping by the next tick', async () => {
      const hub = app.get(SessionHub);
      const socket = await authed('owner-token', { autoPong: false });
      await join(socket);
      const [server] = serverSockets();
      const terminate = vi.spyOn(server as WebSocket, 'terminate');

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS); // ping goes out
      expect(terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS); // still no pong
      expect(terminate).toHaveBeenCalledOnce();
      expect(hub.liveSessionCount()).toBe(0);
    });

    it('keeps a socket that keeps answering', async () => {
      const socket = await authed('owner-token');
      const [server] = serverSockets();
      const terminate = vi.spyOn(server as WebSocket, 'terminate');
      const ponged = (): Promise<void> => new Promise((resolve) => (server as WebSocket).once('pong', () => resolve()));
      for (let i = 0; i < 3; i += 1) {
        const answered = ponged();
        vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
        await answered;
      }
      expect(terminate).not.toHaveBeenCalled();
      expect(socket.readyState).toBe(WebSocket.OPEN);
    });

    it('clears its interval on module destroy', async () => {
      await authed('owner-token');
      const before = vi.getTimerCount();
      app.get(CollabGateway).onModuleDestroy();
      expect(vi.getTimerCount()).toBe(before - 1);
    });
  });

  describe('backpressure', () => {
    const closed = (socket: WebSocket): Promise<{ code: number; reason: string }> =>
      new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));

    it('closes a slow consumer with 1013 slow_consumer instead of queuing more', async () => {
      const hub = app.get(SessionHub);
      const disconnect = vi.spyOn(hub, 'disconnect');
      const host = await authed('owner-token');
      const viewer = await authed('member-token');
      await join(host);
      await join(viewer);
      const [, viewerServer] = serverSockets();
      Object.defineProperty(viewerServer, 'bufferedAmount', { get: () => MAX_BUFFERED_BYTES + 1 });

      const gone = closed(viewer);
      host.send(frame({ type: 'terminal_output', session_id: session.id, terminal_id: terminal, data: [1] }));
      expect(await gone).toEqual({ code: 1013, reason: 'slow_consumer' });
      expect(disconnect.mock.calls.some(([conn]) => conn.userId === member)).toBe(true);
    });

    it('detaches a consumer that became slow mid-broadcast only after every peer was served', async () => {
      const third = newUserId();
      const hub = app.get(SessionHub);
      const events: string[] = [];
      const disconnect = hub.disconnect.bind(hub);
      vi.spyOn(hub, 'disconnect').mockImplementation((conn) => {
        events.push(`disconnect:${conn.userId === member ? 'slow' : 'other'}`);
        disconnect(conn);
      });
      const host = await authed('owner-token');
      const slow = await authed('member-token');
      tokens['third-token'] = { userId: third, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
      workspace.addMember(owner, third);
      const healthy = await authed('third-token');
      await join(host);
      await join(slow);
      await join(healthy);
      const [, slowServer, healthyServer] = serverSockets();
      Object.defineProperty(slowServer, 'bufferedAmount', { get: () => MAX_BUFFERED_BYTES + 1 });
      const healthySend = healthyServer.send.bind(healthyServer);
      vi.spyOn(healthyServer, 'send').mockImplementation(((...args: Parameters<WebSocket['send']>) => {
        events.push('send:healthy');
        return healthySend(...args);
      }) as WebSocket['send']);

      const out = frame({ type: 'terminal_output', session_id: session.id, terminal_id: terminal, data: [1] });
      const received = next(healthy);
      const gone = closed(slow);
      host.send(out);
      expect(await received).toBe(out);
      expect(await gone).toEqual({ code: 1013, reason: 'slow_consumer' });
      expect(events).toEqual(['send:healthy', 'disconnect:slow']);
    });

    it('still closes a slow consumer when detaching it from the hub throws', async () => {
      const hub = app.get(SessionHub);
      vi.spyOn(hub, 'disconnect').mockImplementation(() => {
        throw new Error('boom');
      });
      const host = await authed('owner-token');
      const viewer = await authed('member-token');
      await join(host);
      await join(viewer);
      const [, viewerServer] = serverSockets();
      Object.defineProperty(viewerServer, 'bufferedAmount', { get: () => MAX_BUFFERED_BYTES + 1 });

      const gone = closed(viewer);
      host.send(frame({ type: 'terminal_output', session_id: session.id, terminal_id: terminal, data: [1] }));
      expect(await gone).toEqual({ code: 1013, reason: 'slow_consumer' });
    });

    it('keeps delivering to a consumer under the cap', async () => {
      const host = await authed('owner-token');
      const viewer = await authed('member-token');
      await join(host);
      await join(viewer);
      const [, viewerServer] = serverSockets();
      Object.defineProperty(viewerServer, 'bufferedAmount', { get: () => MAX_BUFFERED_BYTES });
      const out = frame({ type: 'terminal_output', session_id: session.id, terminal_id: terminal, data: [1] });
      const received = next(viewer);
      host.send(out);
      expect(await received).toBe(out);
    });
  });
});
