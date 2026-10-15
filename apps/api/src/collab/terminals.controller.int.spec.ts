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

type TerminalBody = { id: string; name: string; command: string; args: string[]; cwd: string | null };

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
