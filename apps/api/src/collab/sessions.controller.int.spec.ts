import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { InvitationId, SessionId, UserId, WorkspaceId } from '@opencollab/domain';
import { SessionRepository } from '../persistence/session.repository';
import { WorkspaceRepository } from '../persistence/workspace.repository';
import { truncateAll } from '../persistence/test-db';
import { startCollabTestApp, type CollabTestApp } from './test-app';

let t: CollabTestApp;
let sessions: SessionRepository;
let workspaces: WorkspaceRepository;

beforeAll(async () => {
  t = await startCollabTestApp();
  sessions = new SessionRepository(t.prisma);
  workspaces = new WorkspaceRepository(t.prisma);
});
afterAll(() => t.close());
beforeEach(() => truncateAll(t.prisma));

interface Res {
  status: number;
  body: unknown;
}

async function call(method: string, path: string, body?: unknown, token?: string): Promise<Res> {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

const get = (path: string, token?: string) => call('GET', path, undefined, token);
const post = (path: string, body?: unknown, token?: string) => call('POST', path, body ?? {}, token);
const del = (path: string, token?: string) => call('DELETE', path, undefined, token);
const patch = (path: string, body?: unknown, token?: string) => call('PATCH', path, body ?? {}, token);

let counter = 0;
async function registerUser(prefix = 'user'): Promise<{ id: string; token: string }> {
  counter += 1;
  const username = `${prefix}${counter}`;
  const res = await post('/auth/register', {
    username,
    password: 'correct horse battery',
    displayName: prefix,
  });
  expect(res.status).toBe(201);
  const body = res.body as { accessToken: string; user: { id: string } };
  return { id: body.user.id, token: body.accessToken };
}

async function createWorkspace(ownerToken: string, name = 'ws'): Promise<{ id: string }> {
  const res = await post('/workspaces', { name }, ownerToken);
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

// Seeds a member straight through the repository: invitations belong to T4.
async function seedMember(workspaceId: WorkspaceId, ownerId: UserId, memberId: UserId): Promise<void> {
  const ws = await workspaces.find(workspaceId);
  expect(ws).toBeTruthy();
  ws!.addMember(ownerId, memberId);
  await workspaces.save(ws!);
}

type SessionBody = {
  id: string;
  name: string;
  terminals: { id: string; name: string; command: string; args: string[]; cwd: string | null }[];
};

describe('POST /workspaces/:workspaceId/sessions', () => {
  it('creates a session with the caller as owner (201, empty terminals)', async () => {
    const owner = await registerUser();
    const ws = await createWorkspace(owner.token);

    const res = await post(`/workspaces/${ws.id}/sessions`, { name: 'Standup' }, owner.token);
    expect(res.status).toBe(201);
    const body = res.body as SessionBody;
    expect(body.name).toBe('Standup');
    expect(body.id).toBeTruthy();
    expect(body.terminals).toEqual([]);
  });

  it('returns 403 for a member who is not the owner', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const ws = await createWorkspace(owner.token);
    await seedMember(ws.id as WorkspaceId, owner.id as UserId, member.id as UserId);

    const res = await post(`/workspaces/${ws.id}/sessions`, { name: 'x' }, member.token);
    expect(res.status).toBe(403);
  });

  it('returns 404 for a stranger (no access) and for an unknown workspace', async () => {
    const owner = await registerUser();
    const stranger = await registerUser();
    const ws = await createWorkspace(owner.token);

    expect((await post(`/workspaces/${ws.id}/sessions`, { name: 'x' }, stranger.token)).status).toBe(404);
    expect(
      (await post('/workspaces/00000000-0000-0000-0000-000000000000/sessions', { name: 'x' }, owner.token))
        .status,
    ).toBe(404);
  });

  it('requires auth and a valid strict body (S14)', async () => {
    const owner = await registerUser();
    const ws = await createWorkspace(owner.token);

    expect((await post(`/workspaces/${ws.id}/sessions`, { name: 'x' })).status).toBe(401);
    expect((await post(`/workspaces/${ws.id}/sessions`, { name: '' }, owner.token)).status).toBe(400);
    expect((await post(`/workspaces/${ws.id}/sessions`, { name: '   ' }, owner.token)).status).toBe(400);
    expect(
      (await post(`/workspaces/${ws.id}/sessions`, { name: 'x', extra: true }, owner.token)).status,
    ).toBe(400);
  });
});

describe('GET /workspaces/:workspaceId/sessions', () => {
  it('lists the sessions of the workspace for owner and member, with terminals in position order', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const ws = await createWorkspace(owner.token);
    await seedMember(ws.id as WorkspaceId, owner.id as UserId, member.id as UserId);

    const created = (
      await post(`/workspaces/${ws.id}/sessions`, { name: 'first' }, owner.token)
    ).body as SessionBody;
    await post(`/workspaces/${ws.id}/sessions`, { name: 'second' }, owner.token);

    // Seed terminals straight through the repository (endpoints belong to T3):
    // two terminals whose stored order must survive the list projection.
    const wsAggregate = await workspaces.find(ws.id as WorkspaceId);
    const aggregate = await sessions.find(created.id as SessionId);
    expect(aggregate).toBeTruthy();
    aggregate!.addTerminal(wsAggregate!, owner.id as UserId, {
      name: 'a',
      command: 'echo',
      args: ['a'],
      env: [],
    });
    aggregate!.addTerminal(wsAggregate!, owner.id as UserId, {
      name: 'b',
      command: 'echo',
      args: ['b'],
      env: [],
      cwd: '/tmp',
    });
    await sessions.save(aggregate!);

    const forOwner = (await get(`/workspaces/${ws.id}/sessions`, owner.token)).body as SessionBody[];
    expect(forOwner.map((s) => s.name)).toEqual(['first', 'second']);
    const withTerminals = forOwner.find((s) => s.id === created.id)!;
    expect(withTerminals.terminals.map((tm) => tm.name)).toEqual(['a', 'b']);
    expect(withTerminals.terminals[0]).toMatchObject({ command: 'echo', args: ['a'], cwd: null });
    expect(withTerminals.terminals[1]).toMatchObject({ command: 'echo', args: ['b'], cwd: '/tmp' });

    const forMember = (await get(`/workspaces/${ws.id}/sessions`, member.token)).body as SessionBody[];
    expect(forMember.map((s) => s.name)).toEqual(['first', 'second']);
  });

  it('returns 404 for a stranger and for an unknown workspace', async () => {
    const owner = await registerUser();
    const stranger = await registerUser();
    const ws = await createWorkspace(owner.token);
    await post(`/workspaces/${ws.id}/sessions`, { name: 'x' }, owner.token);

    expect((await get(`/workspaces/${ws.id}/sessions`, stranger.token)).status).toBe(404);
    expect((await get('/workspaces/00000000-0000-0000-0000-000000000000/sessions', owner.token)).status).toBe(
      404,
    );
    expect((await get(`/workspaces/${ws.id}/sessions`)).status).toBe(401);
  });
});

describe('GET /sessions/:id', () => {
  it('returns the session detail with terminals for the owner', async () => {
    const owner = await registerUser();
    const ws = await createWorkspace(owner.token);
    const created = (
      await post(`/workspaces/${ws.id}/sessions`, { name: 'detail' }, owner.token)
    ).body as SessionBody;

    const res = await get(`/sessions/${created.id}`, owner.token);
    expect(res.status).toBe(200);
    const body = res.body as SessionBody;
    expect(body.id).toBe(created.id);
    expect(body.name).toBe('detail');
    expect(body.terminals).toEqual([]);
  });

  it('allows a member and a guest to view, and rejects a stranger with 403', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const guest = await registerUser();
    const stranger = await registerUser();
    const ws = await createWorkspace(owner.token);
    await seedMember(ws.id as WorkspaceId, owner.id as UserId, member.id as UserId);
    const created = (
      await post(`/workspaces/${ws.id}/sessions`, { name: 'shared' }, owner.token)
    ).body as SessionBody;

    // Guest seeding mirrors T1's approach: the domain invitation flow is T4,
    // so the guest role is applied directly on the aggregate.
    const aggregate = await sessions.find(created.id as SessionId);
    const wsAggregate = await workspaces.find(ws.id as WorkspaceId);
    aggregate!.acceptInvitation(wsAggregate!, {
      id: '00000000-0000-0000-0000-000000000001' as InvitationId,
      target: { kind: 'session', sessionId: aggregate!.id },
      invitee: guest.id as UserId,
      invitedBy: owner.id as UserId,
    });
    await sessions.save(aggregate!);

    expect((await get(`/sessions/${created.id}`, member.token)).status).toBe(200);
    expect((await get(`/sessions/${created.id}`, guest.token)).status).toBe(200);
    expect((await get(`/sessions/${created.id}`, stranger.token)).status).toBe(403);
    expect((await get(`/sessions/${created.id}`)).status).toBe(401);
  });

  it('returns 404 for an unknown session', async () => {
    const owner = await registerUser();
    expect((await get('/sessions/00000000-0000-0000-0000-000000000000', owner.token)).status).toBe(404);
  });
});

// S7: explicit session ids power the desktop's idempotent cloud round-trip.
describe('POST /workspaces/:workspaceId/sessions with explicit id', () => {
  it('creates the session with the caller-provided id (201)', async () => {
    const owner = await registerUser();
    const ws = await createWorkspace(owner.token);
    const id = '20000000-0000-4000-8000-000000000001';

    const res = await post(`/workspaces/${ws.id}/sessions`, { name: 'Con id', id }, owner.token);
    expect(res.status).toBe(201);
    const body = res.body as { id: string; name: string };
    expect(body.id).toBe(id);
    expect(body.name).toBe('Con id');
  });

  it('returns 200 with the current view for a same-owner retry (idempotent)', async () => {
    const owner = await registerUser();
    const ws = await createWorkspace(owner.token);
    const id = '20000000-0000-4000-8000-000000000002';
    await post(`/workspaces/${ws.id}/sessions`, { name: 'Original', id }, owner.token);

    const res = await post(`/workspaces/${ws.id}/sessions`, { name: 'Original', id }, owner.token);
    expect(res.status).toBe(200);
    const body = res.body as { id: string; name: string };
    expect(body.id).toBe(id);
    expect(body.name).toBe('Original');

    const list = (await get(`/workspaces/${ws.id}/sessions`, owner.token)).body as { id: string }[];
    expect(list.filter((s) => s.id === id)).toHaveLength(1);
  });

  it('returns 409 for a session id owned by another workspace owner', async () => {
    const owner = await registerUser();
    const other = await registerUser();
    const ws = await createWorkspace(owner.token);
    const foreign = await createWorkspace(other.token, 'extranjero');
    const taken = (
      await post(`/workspaces/${foreign.id}/sessions`, { name: 'suyo' }, other.token)
    ).body as { id: string };

    const res = await post(`/workspaces/${ws.id}/sessions`, { name: 'mío', id: taken.id }, owner.token);
    expect(res.status).toBe(409);
  });

  it('rejects a non-uuid id with 400', async () => {
    const owner = await registerUser();
    const ws = await createWorkspace(owner.token);
    expect(
      (await post(`/workspaces/${ws.id}/sessions`, { name: 'x', id: 'not-a-uuid' }, owner.token)).status,
    ).toBe(400);
  });
});

// S7: session rename and delete complete the desktop's snapshot reconciliation.
describe('PATCH /sessions/:id', () => {
  it('renames for the owner (200 with the current session view)', async () => {
    const owner = await registerUser();
    const ws = await createWorkspace(owner.token);
    const session = (
      await post(`/workspaces/${ws.id}/sessions`, { name: 'antes' }, owner.token)
    ).body as SessionBody;

    const res = await patch(`/sessions/${session.id}`, { name: 'Renombrada' }, owner.token);
    expect(res.status).toBe(200);
    const body = res.body as SessionBody;
    expect(body.id).toBe(session.id);
    expect(body.name).toBe('Renombrada');
    expect(body.terminals).toEqual([]);

    const persisted = await sessions.find(session.id as SessionId);
    expect(persisted?.name).toBe('Renombrada');
  });

  it('returns 403 for a member and a stranger, 404 for unknown, 401 unauthenticated', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const stranger = await registerUser();
    const ws = await createWorkspace(owner.token);
    await seedMember(ws.id as WorkspaceId, owner.id as UserId, member.id as UserId);
    const session = (
      await post(`/workspaces/${ws.id}/sessions`, { name: 'compartida' }, owner.token)
    ).body as SessionBody;
    const other = await registerUser();
    const otherWs = await createWorkspace(other.token, 'otro');

    expect((await patch(`/sessions/${session.id}`, { name: 'x' }, member.token)).status).toBe(403);
    expect((await patch(`/sessions/${session.id}`, { name: 'x' }, stranger.token)).status).toBe(403);
    expect((await patch('/sessions/00000000-0000-0000-0000-000000000000', { name: 'x' }, owner.token)).status).toBe(404);
    // A workspace id is not a session id: an unknown session answers 404.
    expect((await patch(`/sessions/${otherWs.id}`, { name: 'x' }, owner.token)).status).toBe(404);
    expect((await patch(`/sessions/${session.id}`, { name: 'x' })).status).toBe(401);
  });

  it('rejects a blank name with 400', async () => {
    const owner = await registerUser();
    const ws = await createWorkspace(owner.token);
    const session = (
      await post(`/workspaces/${ws.id}/sessions`, { name: 's' }, owner.token)
    ).body as SessionBody;
    expect((await patch(`/sessions/${session.id}`, { name: '' }, owner.token)).status).toBe(400);
    expect((await patch(`/sessions/${session.id}`, { name: '   ' }, owner.token)).status).toBe(400);
    expect((await patch(`/sessions/${session.id}`, { extra: true }, owner.token)).status).toBe(400);
  });
});

describe('DELETE /sessions/:id', () => {
  it('deletes for the owner (204) and removes its terminals', async () => {
    const owner = await registerUser();
    const ws = await createWorkspace(owner.token);
    const session = (
      await post(`/workspaces/${ws.id}/sessions`, { name: 'borrar' }, owner.token)
    ).body as SessionBody;
    await post(`/sessions/${session.id}/terminals`, { name: 't', command: 'sh' }, owner.token);
    expect(await t.prisma.terminal.count()).toBe(1);

    const res = await del(`/sessions/${session.id}`, owner.token);
    expect(res.status).toBe(204);

    expect(await t.prisma.terminal.count()).toBe(0);
    expect((await get(`/sessions/${session.id}`, owner.token)).status).toBe(404);
    // The workspace and the parent grouping survive the session delete.
    expect(await t.prisma.workspace.count()).toBe(1);
    expect((await get(`/workspaces/${ws.id}/sessions`, owner.token)).body).toEqual([]);
  });

  it('returns 403 for a member and a stranger, 404 for unknown, 401 unauthenticated', async () => {
    const owner = await registerUser("owner");
    const member = await registerUser();
    const stranger = await registerUser();
    const ws = await createWorkspace(owner.token);
    await seedMember(ws.id as WorkspaceId, owner.id as UserId, member.id as UserId);
    const session = (
      await post(`/workspaces/${ws.id}/sessions`, { name: 'protegida' }, owner.token)
    ).body as SessionBody;

    expect((await del(`/sessions/${session.id}`, member.token)).status).toBe(403);
    expect((await del(`/sessions/${session.id}`, stranger.token)).status).toBe(403);
    expect((await del('/sessions/00000000-0000-0000-0000-000000000000', owner.token)).status).toBe(404);
    expect((await del(`/sessions/${session.id}`)).status).toBe(401);
  });
});
