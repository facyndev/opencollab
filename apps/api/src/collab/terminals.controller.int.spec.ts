import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { SessionId, UserId, WorkspaceId } from '@opencollab/domain';
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
const put = (path: string, body?: unknown, token?: string) => call('PUT', path, body ?? {}, token);

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

async function seedMember(workspaceId: WorkspaceId, ownerId: UserId, memberId: UserId): Promise<void> {
  const ws = await workspaces.find(workspaceId);
  expect(ws).toBeTruthy();
  ws!.addMember(ownerId, memberId);
  await workspaces.save(ws!);
}

// Creates workspace + session through the endpoints added in T1/T2.
async function seedSession(ownerToken: string, name = 'sess'): Promise<{ wsId: string; sessionId: string }> {
  const ws = (await post('/workspaces', { name: 'ws' }, ownerToken)).body as { id: string };
  const session = (
    await post(`/workspaces/${ws.id}/sessions`, { name }, ownerToken)
  ).body as { id: string };
  return { wsId: ws.id, sessionId: session.id };
}

type TerminalBody = {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string | null;
  agent: string | null;
  minimized: boolean;
};

// S7: the terminal view the desktop round-trips — exactly seven fields, never
// seq (DOM order bookkeeping) nor env (secrets stay client-side).
const TERMINAL_FIELDS = ['agent', 'args', 'command', 'cwd', 'id', 'minimized', 'name'] as const;

describe('POST /sessions/:id/terminals', () => {
  it('appends a terminal for the owner and exposes it in the session detail (201)', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);

    const res = await post(
      `/sessions/${sessionId}/terminals`,
      { name: 'shell', command: 'pwsh', args: ['-NoLogo'], cwd: 'C:/tmp' },
      owner.token,
    );
    expect(res.status).toBe(201);
    const body = res.body as TerminalBody;
    expect(body.name).toBe('shell');
    expect(body.command).toBe('pwsh');
    expect(body.args).toEqual(['-NoLogo']);
    expect(body.cwd).toBe('C:/tmp');
    expect('env' in body).toBe(false);

    const detail = (await get(`/sessions/${sessionId}`, owner.token)).body as {
      terminals: TerminalBody[];
    };
    expect(detail.terminals).toHaveLength(1);
    expect(detail.terminals[0]?.id).toBe(body.id);
  });

  it('defaults args to [] and cwd to null when omitted', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);

    const res = await post(`/sessions/${sessionId}/terminals`, { name: 's', command: 'bash' }, owner.token);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ args: [], cwd: null });
  });

  it('returns 403 for a member and a stranger, 404 for an unknown session', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const stranger = await registerUser();
    const { wsId, sessionId } = await seedSession(owner.token);
    await seedMember(wsId as WorkspaceId, owner.id as UserId, member.id as UserId);

    expect(
      (await post(`/sessions/${sessionId}/terminals`, { name: 's', command: 'x' }, member.token)).status,
    ).toBe(403);
    expect(
      (await post(`/sessions/${sessionId}/terminals`, { name: 's', command: 'x' }, stranger.token)).status,
    ).toBe(403);
    expect(
      (await post('/sessions/00000000-0000-0000-0000-000000000000/terminals', { name: 's', command: 'x' }, owner.token))
        .status,
    ).toBe(404);
    expect(
      (await post(`/sessions/${sessionId}/terminals`, { name: 's', command: 'x' })).status,
    ).toBe(401);
  });

  it('rejects invalid bodies with 400 and never accepts env (S7/S14)', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);
    const path = `/sessions/${sessionId}/terminals`;

    expect((await post(path, { name: 's' }, owner.token)).status).toBe(400);
    expect((await post(path, { name: 's', command: '' }, owner.token)).status).toBe(400);
    expect((await post(path, { name: 's', command: '   ' }, owner.token)).status).toBe(400);
    expect((await post(path, { name: 's', command: 'x', env: [['K', 'V']] }, owner.token)).status).toBe(400);
    expect((await post(path, { name: 's', command: 'x', args: 'not-array' }, owner.token)).status).toBe(400);
    expect((await post(path, { name: 's', command: 'x', cwd: 42 }, owner.token)).status).toBe(400);
    expect((await post(path, { name: 's', command: 'x', extra: true }, owner.token)).status).toBe(400);
  });

  it('never persists env even when the caller tries to send it (strict rejection)', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);
    const rejected = await post(
      `/sessions/${sessionId}/terminals`,
      { name: 's', command: 'x', env: [['SECRET', 'v']] },
      owner.token,
    );
    expect(rejected.status).toBe(400);

    // The session stays empty and, on a valid create, the stored profile keeps env=[].
    const created = await post(
      `/sessions/${sessionId}/terminals`,
      { name: 's', command: 'x' },
      owner.token,
    );
    expect(created.status).toBe(201);
    const aggregate = await sessions.find(sessionId as SessionId);
    expect(aggregate!.terminals[0]?.profile.env).toEqual([]);
  });
});

describe('DELETE /sessions/:id/terminals/:terminalId', () => {
  it('removes the terminal for the owner (204) and it disappears from the detail', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);
    const created = (
      await post(`/sessions/${sessionId}/terminals`, { name: 's', command: 'x' }, owner.token)
    ).body as TerminalBody;

    const res = await del(`/sessions/${sessionId}/terminals/${created.id}`, owner.token);
    expect(res.status).toBe(204);

    const detail = (await get(`/sessions/${sessionId}`, owner.token)).body as {
      terminals: TerminalBody[];
    };
    expect(detail.terminals).toEqual([]);
  });

  it('returns 404 for an unknown terminal or session', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);

    expect(
      (await del(`/sessions/${sessionId}/terminals/00000000-0000-0000-0000-000000000000`, owner.token)).status,
    ).toBe(404);
    expect(
      (await del('/sessions/00000000-0000-0000-0000-000000000000/terminals/00000000-0000-0000-0000-000000000000', owner.token))
        .status,
    ).toBe(404);
  });

  it('returns 403 for a member and a stranger before checking terminal existence', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const stranger = await registerUser();
    const { wsId, sessionId } = await seedSession(owner.token);
    await seedMember(wsId as WorkspaceId, owner.id as UserId, member.id as UserId);
    const created = (
      await post(`/sessions/${sessionId}/terminals`, { name: 's', command: 'x' }, owner.token)
    ).body as TerminalBody;

    expect((await del(`/sessions/${sessionId}/terminals/${created.id}`, member.token)).status).toBe(403);
    // Non-owners must not learn whether a terminal id exists: a stranger probing
    // an unknown id still gets 403, not 404.
    expect(
      (await del(`/sessions/${sessionId}/terminals/00000000-0000-0000-0000-000000000000`, stranger.token)).status,
    ).toBe(403);
    expect((await del(`/sessions/${sessionId}/terminals/${created.id}`)).status).toBe(401);
  });
});

describe('terminal metadata (S7)', () => {
  it('accepts agent and minimized and reflects them in the detail', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);

    const res = await post(
      `/sessions/${sessionId}/terminals`,
      { name: 'claude', command: 'claude', agent: 'claude', minimized: true },
      owner.token,
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ agent: 'claude', minimized: true });
  });

  it('defaults agent to null and minimized to false', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);

    const res = await post(`/sessions/${sessionId}/terminals`, { name: 'sh', command: 'sh' }, owner.token);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ agent: null, minimized: false });

    const detail = (await get(`/sessions/${sessionId}`, owner.token)).body as {
      terminals: TerminalBody[];
    };
    expect(detail.terminals[0]).toMatchObject({ agent: null, minimized: false });
  });

  it('accepts an explicit null agent', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);

    const res = await post(
      `/sessions/${sessionId}/terminals`,
      { name: 'sh', command: 'sh', agent: null },
      owner.token,
    );
    expect(res.status).toBe(201);
    expect((res.body as TerminalBody).agent).toBeNull();
  });

  it('rejects invalid metadata with 400', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);
    const path = `/sessions/${sessionId}/terminals`;

    expect((await post(path, { name: 's', command: 'x', agent: 42 }, owner.token)).status).toBe(400);
    expect((await post(path, { name: 's', command: 'x', minimized: 'yes' }, owner.token)).status).toBe(400);
    expect((await post(path, { name: 's', command: 'x', seq: 3 }, owner.token)).status).toBe(400);
    expect((await post(path, { name: 's', command: 'x', env: [] }, owner.token)).status).toBe(400);
  });
});

// S7: explicit terminal ids — idempotent for a same-owner id, conflict otherwise.
describe('POST /sessions/:id/terminals with explicit id', () => {
  it('creates the terminal with the caller-provided id (201)', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);
    const id = '30000000-0000-4000-8000-000000000001';

    const res = await post(
      `/sessions/${sessionId}/terminals`,
      { name: 'sh', command: 'sh', id },
      owner.token,
    );
    expect(res.status).toBe(201);
    expect((res.body as TerminalBody).id).toBe(id);
  });

  it('returns 200 with the current terminal for a same-owner retry (idempotent)', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);
    const id = '30000000-0000-4000-8000-000000000002';
    await post(
      `/sessions/${sessionId}/terminals`,
      { name: 'sh', command: 'sh', id, agent: 'claude', minimized: true },
      owner.token,
    );

    const res = await post(`/sessions/${sessionId}/terminals`, { name: 'sh', command: 'sh', id }, owner.token);
    expect(res.status).toBe(200);
    // The current stored terminal comes back, not a second terminal.
    expect(res.body).toMatchObject({ id, name: 'sh', agent: 'claude', minimized: true });
    expect(await t.prisma.terminal.count()).toBe(1);
  });

  it('returns 409 for a terminal id owned by another user', async () => {
    const owner = await registerUser();
    const other = await registerUser();
    const { sessionId } = await seedSession(owner.token);
    const otherSession = await seedSession(other.token);
    const taken = (
      await post(
        `/sessions/${otherSession.sessionId}/terminals`,
        { name: 'suyo', command: 'sh' },
        other.token,
      )
    ).body as TerminalBody;

    const res = await post(
      `/sessions/${sessionId}/terminals`,
      { name: 'mío', command: 'sh', id: taken.id },
      owner.token,
    );
    expect(res.status).toBe(409);
  });

  it('rejects a non-uuid id with 400', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);
    expect(
      (await post(
        `/sessions/${sessionId}/terminals`,
        { name: 's', command: 'x', id: 'nope' },
        owner.token,
      )).status,
    ).toBe(400);
  });
});

describe('PATCH /sessions/:id/terminals/:terminalId', () => {
  it('patches one field for the owner and keeps the rest (200)', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);
    const created = (
      await post(
        `/sessions/${sessionId}/terminals`,
        { name: 'sh', command: 'sh', args: ['-l'], cwd: '/tmp', agent: 'claude' },
        owner.token,
      )
    ).body as TerminalBody;

    const res = await patch(
      `/sessions/${sessionId}/terminals/${created.id}`,
      { name: 'renamed' },
      owner.token,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: created.id,
      name: 'renamed',
      command: 'sh',
      args: ['-l'],
      cwd: '/tmp',
      agent: 'claude',
      minimized: false,
    });

    const detail = (await get(`/sessions/${sessionId}`, owner.token)).body as {
      terminals: TerminalBody[];
    };
    expect(detail.terminals[0]).toEqual(res.body);
  });

  it('clears agent/minimized/cwd with null and toggles minimized', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);
    const created = (
      await post(
        `/sessions/${sessionId}/terminals`,
        { name: 'claude', command: 'claude', agent: 'claude', minimized: false, cwd: '/tmp' },
        owner.token,
      )
    ).body as TerminalBody;

    const res = await patch(
      `/sessions/${sessionId}/terminals/${created.id}`,
      { agent: null, minimized: true, cwd: null },
      owner.token,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: created.id,
      name: 'claude',
      command: 'claude',
      args: [],
      cwd: null,
      agent: null,
      minimized: true,
    });
  });

  it('never accepts seq or env anywhere in the body (S14)', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);
    const created = (
      await post(`/sessions/${sessionId}/terminals`, { name: 'sh', command: 'sh' }, owner.token)
    ).body as TerminalBody;
    const path = `/sessions/${sessionId}/terminals/${created.id}`;

    expect((await patch(path, { seq: 3 }, owner.token)).status).toBe(400);
    expect((await patch(path, { env: [['K', 'V']] }, owner.token)).status).toBe(400);
  });

  it('rejects invalid partial bodies with 400', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);
    const created = (
      await post(`/sessions/${sessionId}/terminals`, { name: 'sh', command: 'sh' }, owner.token)
    ).body as TerminalBody;
    const path = `/sessions/${sessionId}/terminals/${created.id}`;

    expect((await patch(path, { name: 42 }, owner.token)).status).toBe(400);
    expect((await patch(path, { command: '   ' }, owner.token)).status).toBe(400);
    expect((await patch(path, { args: 'x' }, owner.token)).status).toBe(400);
    expect((await patch(path, { cwd: 7 }, owner.token)).status).toBe(400);
    expect((await patch(path, { minimized: 1 }, owner.token)).status).toBe(400);
    // An empty patch is a valid no-op.
    expect((await patch(path, {}, owner.token)).status).toBe(200);
  });

  it('keeps the existing access matrix', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const stranger = await registerUser();
    const { wsId, sessionId } = await seedSession(owner.token);
    await seedMember(wsId as WorkspaceId, owner.id as UserId, member.id as UserId);
    const created = (
      await post(`/sessions/${sessionId}/terminals`, { name: 'sh', command: 'sh' }, owner.token)
    ).body as TerminalBody;
    const path = `/sessions/${sessionId}/terminals/${created.id}`;

    expect((await patch(path, { name: 'x' }, member.token)).status).toBe(403);
    // A stranger probing a terminal id of a session they cannot see gets 403, not 404.
    expect((await patch(path, { name: 'x' }, stranger.token)).status).toBe(403);
    expect(
      (await patch(
        `/sessions/${sessionId}/terminals/00000000-0000-0000-0000-000000000000`,
        { name: 'x' },
        owner.token,
      )).status,
    ).toBe(404);
    expect(
      (await patch(
        '/sessions/00000000-0000-0000-0000-000000000000/terminals/00000000-0000-0000-0000-000000000000',
        { name: 'x' },
        owner.token,
      )).status,
    ).toBe(404);
    expect((await patch(path, { name: 'x' })).status).toBe(401);
  });
});

describe('PUT /sessions/:id/terminals/order', () => {
  it('applies the new order and returns the terminal views in it (200)', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);
    for (const [index, id] of [
      '40000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000002',
      '40000000-0000-4000-8000-000000000003',
    ].entries()) {
      await post(`/sessions/${sessionId}/terminals`, { name: `t${index}`, command: 'sh', id }, owner.token);
    }
    const created = ((await get(`/sessions/${sessionId}`, owner.token)).body as { terminals: TerminalBody[] })
      .terminals;
    const want = [created[2]!.id, created[0]!.id, created[1]!.id];

    const res = await put(`/sessions/${sessionId}/terminals/order`, { ids: want }, owner.token);
    expect(res.status).toBe(200);
    const views = res.body as TerminalBody[];
    expect(views.map((v) => v.id)).toEqual(want);
    expect(views.map((v) => v.name)).toEqual(['t2', 't0', 't1']);

    const detail = (await get(`/sessions/${sessionId}`, owner.token)).body as {
      terminals: TerminalBody[];
    };
    expect(detail.terminals.map((tm) => tm.id)).toEqual(want);

    // `position` is atomically rewritten to match the array order.
    const rows = await t.prisma.terminal.findMany({ where: { sessionId }, orderBy: { position: 'asc' } });
    expect(rows.map((r) => r.id)).toEqual(want);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  it('returns 400 for duplicates, an omission or an unknown id', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);
    const first = (
      await post(`/sessions/${sessionId}/terminals`, { name: 'a', command: 'sh' }, owner.token)
    ).body as TerminalBody;
    const second = (
      await post(`/sessions/${sessionId}/terminals`, { name: 'b', command: 'sh' }, owner.token)
    ).body as TerminalBody;
    const path = `/sessions/${sessionId}/terminals/order`;

    expect((await put(path, { ids: [first.id, first.id] }, owner.token)).status).toBe(400);
    expect((await put(path, { ids: [first.id] }, owner.token)).status).toBe(400);
    expect(
      (await put(path, { ids: ['40000000-0000-4000-8000-000000009999'] }, owner.token)).status,
    ).toBe(400);
    expect(
      (await put(
        path,
        { ids: [first.id, second.id, '40000000-0000-4000-8000-000000009999'] },
        owner.token,
      )).status,
    ).toBe(400);
    expect((await put(path, { ids: [] }, owner.token)).status).toBe(400);
    expect((await put(path, { ids: [first.id], extra: true }, owner.token)).status).toBe(400);
    expect((await put(path, { ids: 'a,b' }, owner.token)).status).toBe(400);
  });

  it('keeps the existing access matrix', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const stranger = await registerUser();
    const { wsId, sessionId } = await seedSession(owner.token);
    await seedMember(wsId as WorkspaceId, owner.id as UserId, member.id as UserId);
    const created = (
      await post(`/sessions/${sessionId}/terminals`, { name: 'sh', command: 'sh' }, owner.token)
    ).body as TerminalBody;
    const path = `/sessions/${sessionId}/terminals/order`;

    expect((await put(path, { ids: [created.id] }, member.token)).status).toBe(403);
    expect((await put(path, { ids: [created.id] }, stranger.token)).status).toBe(403);
    expect(
      (await put('/sessions/00000000-0000-0000-0000-000000000000/terminals/order', { ids: [] }, owner.token))
        .status,
    ).toBe(404);
    expect((await put(path, { ids: [created.id] })).status).toBe(401);
  });
});

describe('terminal view shape (additive, never seq/env)', () => {
  it('exposes exactly the seven snapshot fields', async () => {
    const owner = await registerUser();
    const { sessionId } = await seedSession(owner.token);
    const res = await post(
      `/sessions/${sessionId}/terminals`,
      { name: 'sh', command: 'sh', agent: 'claude', minimized: true },
      owner.token,
    );
    expect(Object.keys(res.body as object).sort()).toEqual([...TERMINAL_FIELDS]);

    const detail = (await get(`/sessions/${sessionId}`, owner.token)).body as {
      terminals: TerminalBody[];
    };
    expect(Object.keys(detail.terminals[0] as object).sort()).toEqual([...TERMINAL_FIELDS]);
    expect(JSON.stringify(detail)).not.toContain('"seq"');
    expect(JSON.stringify(detail)).not.toContain('"env"');
  });
});
