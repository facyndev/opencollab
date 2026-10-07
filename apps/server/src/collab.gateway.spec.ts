import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { SessionService } from './auth/session.service';
import { CollabGateway } from './collab.gateway';
import { Session, Workspace, newAgentProfile, newUserId, type SessionId, type UserId } from './domain';
import { SESSION_STORE, SessionHub, type SessionStore } from './hub';
import { ConnectionDeadline, TOKEN_GRACE_MS } from './connection-deadline';
import { FORBIDDEN, NOT_JOINED, UNAUTHORIZED } from './protocol';

const frame = (message: object): string => JSON.stringify({ version: 1, message });

describe('CollabGateway', () => {
  let app: INestApplication;
  let url: string;
  let owner: UserId;
  let member: UserId;
  let session: Session;
  let terminal: string;
  let tokens: Record<string, { userId: UserId; expiresAt: number }>;
  const open: WebSocket[] = [];

  beforeEach(async () => {
    owner = newUserId();
    member = newUserId();
    const farFuture = Math.floor(Date.now() / 1000) + 3600;
    tokens = {
      'owner-token': { userId: owner, expiresAt: farFuture },
      'member-token': { userId: member, expiresAt: farFuture },
    };
    const workspace = new Workspace(owner, 'w');
    workspace.addMember(owner, member);
    session = Session.create(workspace, owner, 's');
    terminal = session.addTerminal(workspace, owner, newAgentProfile('sh', 'sh'));
    const store: SessionStore = {
      load: async (id: SessionId) => (id === session.id ? { session, workspace } : undefined),
      save: async () => undefined,
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CollabGateway,
        { provide: SESSION_STORE, useValue: store },
        { provide: SessionHub, useFactory: (s: SessionStore) => new SessionHub(s), inject: [SESSION_STORE] },
        { provide: SessionService, useValue: { verifyAccessClaims: (t: string) => tokens[t] } },
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
  function connect(protocols?: string[]): Promise<WebSocket | number> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, protocols);
      open.push(socket);
      socket.on('open', () => resolve(socket));
      socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      socket.on('error', (error) => {
        if (!/Unexpected server response/.test(String(error))) reject(error);
      });
    });
  }

  async function authed(token: string): Promise<WebSocket> {
    const socket = await connect(['opencollab.v1', `bearer.${token}`]);
    if (typeof socket === 'number') throw new Error(`rejected with ${socket}`);
    return socket;
  }

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

    // Only the timers and the clock are faked: the sockets stay real.
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
  });
});
