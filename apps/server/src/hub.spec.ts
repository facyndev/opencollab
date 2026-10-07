import { beforeEach, describe, expect, it } from 'vitest';

import {
  Session,
  Workspace,
  newAgentProfile,
  newSessionId,
  newUserId,
  type SessionId,
  type TerminalId,
  type UserId,
} from './domain';
import { SessionHub, UNAVAILABLE, type HubConnection, type SessionStore } from './hub';
import {
  FORBIDDEN,
  INCOMPATIBLE_PROTOCOL_VERSION,
  INVALID_MESSAGE,
  NOT_JOINED,
  type Message,
} from './protocol';

class FakeConn implements HubConnection {
  readonly sent: string[] = [];
  constructor(readonly userId: UserId) {}
  send(text: string): void {
    this.sent.push(text);
  }
  get last(): string | undefined {
    return this.sent.at(-1);
  }
}

class FakeStore implements SessionStore {
  loads = 0;
  saves = 0;
  failSave = false;
  private rows = new Map<SessionId, { session: Session; workspace: Workspace }>();

  seed(session: Session, workspace: Workspace): void {
    this.rows.set(session.id, { session, workspace });
  }

  async load(id: SessionId) {
    this.loads += 1;
    // A fresh copy per load, like a repository: eviction must really drop state.
    const row = this.rows.get(id);
    return row && { session: row.session, workspace: row.workspace };
  }

  async save(): Promise<void> {
    if (this.failSave) throw new Error('db down');
    this.saves += 1;
  }
}

const frame = (message: Message): string => JSON.stringify({ version: 1, message });

describe('SessionHub', () => {
  let store: FakeStore;
  let hub: SessionHub;
  let owner: UserId;
  let member: UserId;
  let other: UserId;
  let outsider: UserId;
  let workspace: Workspace;
  let session: Session;
  let terminal: TerminalId;

  const connect = (userId: UserId): FakeConn => {
    const conn = new FakeConn(userId);
    hub.connect(conn);
    return conn;
  };
  const join = async (conn: FakeConn, id: string = session.id): Promise<void> => {
    await hub.receive(conn, frame({ type: 'join_session', session_id: id }));
  };
  const output = (): string =>
    frame({ type: 'terminal_output', session_id: session.id, terminal_id: terminal, data: [104, 105] });
  const input = (user: UserId): string =>
    frame({
      type: 'terminal_input',
      session_id: session.id,
      terminal_id: terminal,
      user_id: user,
      data: [108, 115],
    });
  const setAccess = (target: UserId, access: 'none' | 'view' | 'write'): string =>
    frame({ type: 'access_changed', session_id: session.id, user_id: target, access });

  beforeEach(() => {
    owner = newUserId();
    member = newUserId();
    other = newUserId();
    outsider = newUserId();
    workspace = new Workspace(owner, 'w');
    workspace.addMember(owner, member);
    workspace.addMember(owner, other);
    session = Session.create(workspace, owner, 's');
    terminal = session.addTerminal(workspace, owner, newAgentProfile('sh', 'sh'));
    store = new FakeStore();
    store.seed(session, workspace);
    hub = new SessionHub(store);
  });

  describe('join_session', () => {
    it('answers joined with the current access', async () => {
      const conn = connect(member);
      await join(conn);
      expect(conn.last).toBe(frame({ type: 'joined', session_id: session.id, access: 'view' }));
      const ownerConn = connect(owner);
      await join(ownerConn);
      expect(ownerConn.last).toBe(frame({ type: 'joined', session_id: session.id, access: 'write' }));
    });

    it('is forbidden for a user without view, an unknown session and a malformed id', async () => {
      const stranger = connect(outsider);
      await join(stranger);
      expect(stranger.sent).toEqual([FORBIDDEN]);
      await join(stranger, newSessionId());
      await join(stranger, 'not-a-uuid');
      expect(stranger.sent).toEqual([FORBIDDEN, FORBIDDEN, FORBIDDEN]);
    });

    it('is forbidden once view was revoked for that session', async () => {
      session.setAccess(workspace, owner, member, 'none');
      const conn = connect(member);
      await join(conn);
      expect(conn.sent).toEqual([FORBIDDEN]);
    });

    it('is idempotent for the same connection', async () => {
      const conn = connect(member);
      await join(conn);
      await join(conn);
      expect(conn.sent).toHaveLength(2);
      expect(hub.liveSessionCount()).toBe(1);
    });
  });

  describe('frame validation', () => {
    it('answers the raw parse errors', async () => {
      const conn = connect(owner);
      await hub.receive(conn, 'nope');
      await hub.receive(conn, '{"version":2,"message":{"type":"join_session","session_id":"s"}}');
      expect(conn.sent).toEqual([INVALID_MESSAGE, INCOMPATIBLE_PROTOCOL_VERSION]);
    });

    it('rejects a client-sent joined', async () => {
      const conn = connect(owner);
      await hub.receive(conn, frame({ type: 'joined', session_id: session.id, access: 'write' }));
      expect(conn.sent).toEqual([FORBIDDEN]);
    });

    it('answers not_joined for a session the connection did not join', async () => {
      const conn = connect(owner);
      await hub.receive(conn, output());
      await hub.receive(conn, input(owner));
      await hub.receive(conn, setAccess(member, 'none'));
      expect(conn.sent).toEqual([NOT_JOINED, NOT_JOINED, NOT_JOINED]);
    });
  });

  describe('terminal_output', () => {
    it('fans the original frame out to other viewers, never back to the sender', async () => {
      const host = connect(owner);
      const viewer = connect(member);
      const second = connect(other);
      await join(host);
      await join(viewer);
      await join(second);
      const text = output();
      await hub.receive(host, text);
      expect(viewer.last).toBe(text);
      expect(second.last).toBe(text);
      expect(host.sent).toHaveLength(1); // only its own `joined`
    });

    it('reaches every joined connection of a viewer', async () => {
      const host = connect(owner);
      const a = connect(member);
      const b = connect(member);
      await join(host);
      await join(a);
      await join(b);
      const text = output();
      await hub.receive(host, text);
      expect(a.last).toBe(text);
      expect(b.last).toBe(text);
    });

    it('is forbidden for a non-owner, even one with write', async () => {
      session.setAccess(workspace, owner, member, 'write');
      const host = connect(owner);
      const writer = connect(member);
      await join(host);
      await join(writer);
      await hub.receive(writer, output());
      expect(writer.last).toBe(FORBIDDEN);
      expect(host.sent).toHaveLength(1);
    });

    it('is forbidden for a terminal that is not in the session', async () => {
      const host = connect(owner);
      await join(host);
      await hub.receive(
        host,
        frame({
          type: 'terminal_output',
          session_id: session.id,
          terminal_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
          data: [1],
        }),
      );
      expect(host.last).toBe(FORBIDDEN);
    });
  });

  describe('terminal_input', () => {
    it('needs write: a viewer is forbidden, and a granted writer reaches only the owner', async () => {
      const host = connect(owner);
      const writer = connect(member);
      const bystander = connect(other);
      await join(host);
      await join(writer);
      await join(bystander);

      await hub.receive(writer, input(member));
      expect(writer.last).toBe(FORBIDDEN);
      expect(host.sent).toHaveLength(1);

      await hub.receive(host, setAccess(member, 'write'));
      const text = input(member);
      await hub.receive(writer, text);
      expect(host.last).toBe(text);
      expect(bystander.sent.some((s) => s === text)).toBe(false);
    });

    it('is forbidden when user_id is not the authenticated user', async () => {
      const host = connect(owner);
      const writer = connect(member);
      await join(host);
      await join(writer);
      await hub.receive(host, setAccess(member, 'write'));
      const before = host.sent.length;
      await hub.receive(writer, input(owner));
      expect(writer.last).toBe(FORBIDDEN);
      expect(host.sent).toHaveLength(before);
    });

    it('stops being accepted the moment write is revoked on a live connection', async () => {
      const host = connect(owner);
      const writer = connect(member);
      await join(host);
      await join(writer);
      await hub.receive(host, setAccess(member, 'write'));
      await hub.receive(writer, input(member));
      const delivered = host.sent.length;
      await hub.receive(host, setAccess(member, 'view'));
      await hub.receive(writer, input(member));
      expect(writer.last).toBe(FORBIDDEN);
      expect(host.sent.length).toBe(delivered + 1); // only the access_changed echo
    });

    it('is forbidden for a terminal that is not in the session', async () => {
      const host = connect(owner);
      const writer = connect(member);
      await join(host);
      await join(writer);
      await hub.receive(host, setAccess(member, 'write'));
      await hub.receive(
        writer,
        frame({
          type: 'terminal_input',
          session_id: session.id,
          terminal_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
          user_id: member,
          data: [1],
        }),
      );
      expect(writer.last).toBe(FORBIDDEN);
    });
  });

  describe('access_changed', () => {
    it('is owner-only', async () => {
      const host = connect(owner);
      const viewer = connect(member);
      await join(host);
      await join(viewer);
      await hub.receive(viewer, setAccess(member, 'write'));
      expect(viewer.last).toBe(FORBIDDEN);
      expect(store.saves).toBe(0);
      expect(session.accessOf(workspace, member)).toBe('view');
    });

    it('applies, persists and broadcasts to every joined connection including the target', async () => {
      const host = connect(owner);
      const target = connect(member);
      const bystander = connect(other);
      await join(host);
      await join(target);
      await join(bystander);
      const text = setAccess(member, 'write');
      await hub.receive(host, text);
      expect(session.accessOf(workspace, member)).toBe('write');
      expect(store.saves).toBe(1);
      for (const conn of [host, target, bystander]) expect(conn.last).toBe(text);
    });

    it('unsubscribes a target that lost view, after telling it', async () => {
      const host = connect(owner);
      const target = connect(member);
      const second = connect(member);
      await join(host);
      await join(target);
      await join(second);
      const text = setAccess(member, 'none');
      await hub.receive(host, text);
      expect(target.last).toBe(text);
      expect(second.last).toBe(text);

      const out = output();
      await hub.receive(host, out);
      expect(target.sent.includes(out)).toBe(false);
      expect(second.sent.includes(out)).toBe(false);
      await hub.receive(target, input(member));
      expect(target.last).toBe(NOT_JOINED);
      await join(target);
      expect(target.last).toBe(FORBIDDEN);
    });

    it('turns domain errors into forbidden without persisting', async () => {
      const host = connect(owner);
      await join(host);
      await hub.receive(host, setAccess(owner, 'none')); // cannot change the owner
      expect(host.last).toBe(FORBIDDEN);
      await hub.receive(host, setAccess(outsider, 'view')); // not a participant
      expect(host.last).toBe(FORBIDDEN);
      expect(store.saves).toBe(0);
    });

    it('reverts the in-memory change and reports unavailable when persisting fails', async () => {
      store.failSave = true;
      const host = connect(owner);
      const target = connect(member);
      await join(host);
      await join(target);
      await hub.receive(host, setAccess(member, 'none'));
      expect(host.last).toBe(UNAVAILABLE);
      expect(session.accessOf(workspace, member)).toBe('view');
      expect(target.sent).toHaveLength(1); // only its `joined`
    });
  });

  describe('lifecycle', () => {
    it('loads once for concurrent joins and evicts when the last connection leaves', async () => {
      const a = connect(owner);
      const b = connect(member);
      await Promise.all([join(a), join(b)]);
      expect(store.loads).toBe(1);
      expect(hub.liveSessionCount()).toBe(1);
      hub.disconnect(a);
      expect(hub.liveSessionCount()).toBe(1);
      hub.disconnect(b);
      expect(hub.liveSessionCount()).toBe(0);
      await join(connect(owner));
      expect(store.loads).toBe(2);
    });

    it('lets one connection join several sessions', async () => {
      const second = Session.create(workspace, owner, 's2');
      store.seed(second, workspace);
      const conn = connect(member);
      await join(conn);
      await join(conn, second.id);
      expect(hub.liveSessionCount()).toBe(2);
      hub.disconnect(conn);
      expect(hub.liveSessionCount()).toBe(0);
    });

    it('does not subscribe a connection that closed while its join was loading', async () => {
      const conn = connect(member);
      const pending = join(conn);
      hub.disconnect(conn);
      await pending;
      expect(hub.liveSessionCount()).toBe(0);
      expect(conn.sent).toEqual([]);
    });

    it("handles one connection's frames in order, even when sent back to back", async () => {
      const host = connect(owner);
      const viewer = connect(member);
      await join(viewer);
      await Promise.all([
        hub.receive(host, frame({ type: 'join_session', session_id: session.id })),
        hub.receive(host, output()),
      ]);
      expect(host.sent).toEqual([frame({ type: 'joined', session_id: session.id, access: 'write' })]);
      expect(viewer.last).toBe(output());
    });

    it('drops a failing send without breaking the fan-out', async () => {
      const host = connect(owner);
      const broken = connect(member);
      const healthy = connect(other);
      await join(host);
      await join(broken);
      await join(healthy);
      broken.send = () => {
        throw new Error('socket closed');
      };
      await hub.receive(host, output());
      expect(healthy.last).toBe(output());
    });
  });
});
