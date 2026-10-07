import {
  DomainError,
  parseSessionId,
  type Session,
  type SessionId,
  type TerminalId,
  type UserId,
  type Workspace,
} from './domain';
import { FORBIDDEN, NOT_JOINED, parseFrame, type Message } from './protocol';

/** Nest injection token for the hub's `SessionStore` port. */
export const SESSION_STORE = Symbol('SESSION_STORE');

/** Raw error for a failure that is ours (storage down), not the sender's. */
export const UNAVAILABLE = '{"error":"unavailable"}';

/** One authenticated socket, as the hub sees it. */
export interface HubConnection {
  readonly userId: UserId;
  send(text: string): void;
}

export interface SessionState {
  session: Session;
  workspace: Workspace;
}

/** Port: how the hub reads and writes sessions. The adapter lives in persistence. */
export interface SessionStore {
  load(id: SessionId): Promise<SessionState | undefined>;
  save(session: Session): Promise<void>;
}

interface Live extends SessionState {
  readonly conns: Set<HubConnection>;
}

/**
 * In-memory routing for live sessions. A session is held only while at least
 * one connection is joined, and every incoming message is judged against that
 * live state, so a permission change takes effect on the very next frame.
 * Nothing about access is cached per connection.
 */
export class SessionHub {
  private readonly live = new Map<SessionId, Live>();
  private readonly loading = new Map<SessionId, Promise<SessionState | undefined>>();
  private readonly joined = new Map<HubConnection, Set<SessionId>>();
  private readonly queues = new WeakMap<HubConnection, Promise<void>>();

  constructor(private readonly store: SessionStore) {}

  liveSessionCount(): number {
    return this.live.size;
  }

  connect(conn: HubConnection): void {
    this.joined.set(conn, new Set());
  }

  disconnect(conn: HubConnection): void {
    for (const id of [...(this.joined.get(conn) ?? [])]) this.leave(conn, id);
    this.joined.delete(conn);
  }

  /** Frames of one connection are handled strictly in arrival order. */
  receive(conn: HubConnection, text: string): Promise<void> {
    const next = (this.queues.get(conn) ?? Promise.resolve()).then(() => this.handle(conn, text));
    this.queues.set(conn, next);
    return next;
  }

  private async handle(conn: HubConnection, text: string): Promise<void> {
    if (!this.joined.has(conn)) return;
    const parsed = parseFrame(text);
    if (!parsed.ok) return conn.send(parsed.error);
    try {
      await this.route(conn, text, parsed.envelope.message);
    } catch {
      // Storage failures: tell the sender, never leak details or kill the socket.
      safeSend(conn, UNAVAILABLE);
    }
  }

  private async route(conn: HubConnection, text: string, message: Message): Promise<void> {
    switch (message.type) {
      case 'join_session':
        return this.join(conn, message.session_id);
      case 'joined':
        return conn.send(FORBIDDEN);
      default: {
        const live = this.liveOf(conn, message.session_id as SessionId);
        if (!live) return conn.send(NOT_JOINED);
        switch (message.type) {
          case 'terminal_output':
            return this.output(conn, live, text, message.terminal_id);
          case 'terminal_input':
            return this.input(conn, live, text, message.terminal_id, message.user_id);
          case 'access_changed':
            return this.accessChanged(conn, live, text, message.user_id, message.access);
        }
      }
    }
  }

  private liveOf(conn: HubConnection, id: SessionId): Live | undefined {
    return this.joined.get(conn)?.has(id) ? this.live.get(id) : undefined;
  }

  private async join(conn: HubConnection, rawId: string): Promise<void> {
    let id: SessionId;
    try {
      id = parseSessionId(rawId);
    } catch {
      return conn.send(FORBIDDEN);
    }
    let live = this.live.get(id);
    if (!live) {
      const state = await this.load(id);
      if (!state) return conn.send(FORBIDDEN);
      // Another join may have installed it while this one was loading.
      live = this.live.get(id) ?? this.install(id, state);
    }
    const access = live.session.accessOf(live.workspace, conn.userId);
    // Closed while loading: do not subscribe, and release a session nobody holds.
    if (!this.joined.has(conn)) return this.evictIfEmpty(id);
    if (!live.session.canView(live.workspace, conn.userId)) {
      this.evictIfEmpty(id);
      return conn.send(FORBIDDEN);
    }
    live.conns.add(conn);
    this.joined.get(conn)?.add(id);
    conn.send(JSON.stringify({ version: 1, message: { type: 'joined', session_id: id, access } }));
  }

  private load(id: SessionId): Promise<SessionState | undefined> {
    let pending = this.loading.get(id);
    if (!pending) {
      pending = this.store.load(id).finally(() => this.loading.delete(id));
      this.loading.set(id, pending);
    }
    return pending;
  }

  private install(id: SessionId, state: SessionState): Live {
    const live: Live = { ...state, conns: new Set() };
    this.live.set(id, live);
    return live;
  }

  private output(conn: HubConnection, live: Live, text: string, terminal: string): void {
    if (!live.workspace.isOwner(conn.userId)) return conn.send(FORBIDDEN);
    if (!live.session.terminal(terminal as TerminalId)) return conn.send(FORBIDDEN);
    for (const peer of live.conns) {
      if (peer !== conn && live.session.canView(live.workspace, peer.userId)) safeSend(peer, text);
    }
  }

  private input(conn: HubConnection, live: Live, text: string, terminal: string, user: string): void {
    if (user !== conn.userId) return conn.send(FORBIDDEN);
    if (!live.session.canWrite(live.workspace, conn.userId)) return conn.send(FORBIDDEN);
    if (!live.session.terminal(terminal as TerminalId)) return conn.send(FORBIDDEN);
    // Only the host's machine owns the PTY, so only the owner's sockets get input.
    for (const peer of live.conns) {
      if (live.workspace.isOwner(peer.userId)) safeSend(peer, text);
    }
  }

  private async accessChanged(
    conn: HubConnection,
    live: Live,
    text: string,
    user: string,
    access: 'none' | 'view' | 'write',
  ): Promise<void> {
    const { session, workspace } = live;
    if (!workspace.isOwner(conn.userId)) return conn.send(FORBIDDEN);
    const target = user as UserId;
    const previous = session.accessOf(workspace, target);
    try {
      session.setAccess(workspace, conn.userId, target, access);
    } catch (error) {
      if (error instanceof DomainError) return conn.send(FORBIDDEN);
      throw error;
    }
    try {
      await this.store.save(session);
    } catch (error) {
      session.setAccess(workspace, conn.userId, target, previous);
      throw error;
    }
    for (const peer of [...live.conns]) safeSend(peer, text);
    for (const peer of [...live.conns]) {
      if (peer.userId === target && !session.canView(workspace, target)) this.leave(peer, session.id);
    }
  }

  private leave(conn: HubConnection, id: SessionId): void {
    this.live.get(id)?.conns.delete(conn);
    this.joined.get(conn)?.delete(id);
    this.evictIfEmpty(id);
  }

  private evictIfEmpty(id: SessionId): void {
    if (this.live.get(id)?.conns.size === 0) this.live.delete(id);
  }
}

/** A dead peer must never break delivery to the others. */
function safeSend(conn: HubConnection, text: string): void {
  try {
    conn.send(text);
  } catch {
    // The socket's own close event removes it from the hub.
  }
}
