import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Workspace } from '@opencollab/domain';
import type { UserId, WorkspaceId } from '@opencollab/domain';
import { WorkspaceRepository } from '../persistence/workspace.repository';
import { truncateAll } from '../persistence/test-db';
import { startCollabTestApp, type CollabTestApp } from './test-app';

let t: CollabTestApp;
let workspaces: WorkspaceRepository;

beforeAll(async () => {
  t = await startCollabTestApp();
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

// Seeds a workspace with a member straight through the repository: the
// invitation endpoints belong to a later task, so this setup stays independent.
async function seedWorkspaceWithMember(ownerId: UserId, memberId: UserId, name: string): Promise<WorkspaceId> {
  const ws = new Workspace(ownerId, name);
  ws.addMember(ownerId, memberId);
  await workspaces.save(ws);
  return ws.id;
}

describe('POST /workspaces', () => {
  it('creates a workspace with the caller as owner', async () => {
    const { id, token } = await registerUser();
    const res = await post('/workspaces', { name: 'Proyecto X' }, token);
    expect(res.status).toBe(201);
    const body = res.body as { id: string; name: string; owner: string; members: unknown[] };
    expect(body.name).toBe('Proyecto X');
    expect(body.owner).toBe(id);
    expect(body.members).toEqual([]);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await post('/workspaces', { name: 'x' });
    expect(res.status).toBe(401);
  });

  it('rejects an empty or blank name with 400', async () => {
    const { token } = await registerUser();
    expect((await post('/workspaces', { name: '' }, token)).status).toBe(400);
    expect((await post('/workspaces', { name: '   ' }, token)).status).toBe(400);
  });

  it('rejects unknown fields with 400', async () => {
    const { token } = await registerUser();
    const res = await post('/workspaces', { name: 'x', extra: true }, token);
    expect(res.status).toBe(400);
  });
});

describe('GET /workspaces', () => {
  it('lists only workspaces where the caller is owner or member', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const stranger = await registerUser();

    const mine = (await post('/workspaces', { name: 'mine' }, owner.token)).body as { id: string };
    await post('/workspaces', { name: 'owned-by-member' }, member.token);
    await seedWorkspaceWithMember(owner.id as UserId, member.id as UserId, 'shared');

    const forOwner = (await get('/workspaces', owner.token)).body as { id: string; name: string }[];
    expect(forOwner.map((w) => w.name).sort()).toEqual(['mine', 'shared']);

    // Member owns 'owned-by-member' and belongs to 'shared' (seeded); they have
    // no relation to 'mine', so it must not appear in their list.
    const forMember = (await get('/workspaces', member.token)).body as { name: string }[];
    expect(forMember.map((w) => w.name).sort()).toEqual(['owned-by-member', 'shared']);

    const forStranger = (await get('/workspaces', stranger.token)).body as { name: string }[];
    expect(forStranger).toEqual([]);
    expect(mine.id).toBeTruthy();
  });
});

describe('GET /workspaces/:id', () => {
  it('returns the detail with members for the owner', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const wsId = await seedWorkspaceWithMember(owner.id as UserId, member.id as UserId, 'detail');

    const res = await get(`/workspaces/${wsId}`, owner.token);
    expect(res.status).toBe(200);
    const body = res.body as {
      id: string;
      name: string;
      owner: string;
      members: { userId: string; username: string; displayName: string }[];
    };
    expect(body.id).toBe(wsId);
    expect(body.name).toBe('detail');
    expect(body.owner).toBe(owner.id);
    expect(body.members).toHaveLength(1);
    expect(body.members[0]?.userId).toBe(member.id);
    expect(body.members[0]?.username).toBeTruthy();
    expect(body.members[0]?.displayName).toBeTruthy();
  });

  it('returns 404 for an unknown workspace and 403 for a stranger', async () => {
    const owner = await registerUser();
    const stranger = await registerUser();
    const ws = (await post('/workspaces', { name: 'private' }, owner.token)).body as { id: string };

    expect((await get('/workspaces/00000000-0000-0000-0000-000000000000', owner.token)).status).toBe(404);
    expect((await get(`/workspaces/${ws.id}`, stranger.token)).status).toBe(403);
  });
});
