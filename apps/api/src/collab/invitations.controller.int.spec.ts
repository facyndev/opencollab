import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { InvitationId, UserId, WorkspaceId } from '@opencollab/domain';
import { InvitationRepository } from '../persistence/invitation.repository';
import { WorkspaceRepository } from '../persistence/workspace.repository';
import { truncateAll } from '../persistence/test-db';
import { startCollabTestApp, type CollabTestApp } from './test-app';

let t: CollabTestApp;
let workspaces: WorkspaceRepository;
let invitations: InvitationRepository;

beforeAll(async () => {
  t = await startCollabTestApp();
  workspaces = new WorkspaceRepository(t.prisma);
  invitations = new InvitationRepository(t.prisma);
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
const postEmpty = (path: string, token?: string) => call('POST', path, undefined, token);

let counter = 0;
async function registerUser(prefix = 'user'): Promise<{ id: string; token: string; username: string }> {
  counter += 1;
  const username = `${prefix}${counter}`;
  const res = await post('/auth/register', {
    username,
    password: 'correct horse battery',
    displayName: prefix,
  });
  expect(res.status).toBe(201);
  const body = res.body as { accessToken: string; user: { id: string } };
  return { id: body.user.id, token: body.accessToken, username };
}

async function seedWorkspace(ownerToken: string, name = 'ws'): Promise<{ id: string }> {
  const res = await post('/workspaces', { name }, ownerToken);
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

async function seedSession(ownerToken: string, wsId: string, name = 'sess'): Promise<{ id: string }> {
  const res = await post(`/workspaces/${wsId}/sessions`, { name }, ownerToken);
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

// Seeds a member straight through the repository: no endpoint exists for it.
async function seedMember(workspaceId: WorkspaceId, ownerId: UserId, memberId: UserId): Promise<void> {
  const ws = await workspaces.find(workspaceId);
  expect(ws).toBeTruthy();
  ws!.addMember(ownerId, memberId);
  await workspaces.save(ws!);
}

// Seeds an already-expired invitation straight through the repository: the API
// never creates expiring invitations, so expiry can only be set up this way.
async function seedExpiredWorkspaceInvitation(
  workspaceId: WorkspaceId,
  ownerId: UserId,
  inviteeId: UserId,
): Promise<string> {
  const ws = await workspaces.find(workspaceId);
  expect(ws).toBeTruthy();
  const invitation = ws!.inviteMember(ownerId, inviteeId);
  await invitations.save(invitation, new Date(Date.now() - 60_000));
  return invitation.id;
}

type InvitationBody = {
  id: string;
  target:
    | { kind: 'workspace'; workspaceId: string; name: string }
    | { kind: 'session'; sessionId: string; name: string };
  invitedBy: { userId: string; username: string; displayName: string };
};

const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000';

describe('POST /workspaces/:id/invitations (S9)', () => {
  it('invites a user as member and returns the invitation view (201)', async () => {
    const owner = await registerUser('owner');
    const invitee = await registerUser('invitee');
    const ws = await seedWorkspace(owner.token, 'team');

    const res = await post(`/workspaces/${ws.id}/invitations`, { inviteeId: invitee.id }, owner.token);
    expect(res.status).toBe(201);
    const body = res.body as InvitationBody;
    expect(Object.keys(body).sort()).toEqual(['id', 'invitedBy', 'target']);
    expect(body.target).toEqual({ kind: 'workspace', workspaceId: ws.id, name: 'team' });
    expect(body.invitedBy).toEqual({
      userId: owner.id,
      username: owner.username,
      displayName: 'owner',
    });

    // The invitation is stored as pending.
    const stored = await invitations.find(body.id as InvitationId);
    expect(stored?.status).toBe('pending');
    expect(stored?.invitation.invitee).toBe(invitee.id);
  });

  it('returns 404 for an unknown workspace, 403 for member and stranger, 401 without token', async () => {
    const owner = await registerUser('owner');
    const member = await registerUser('member');
    const stranger = await registerUser('stranger');
    const invitee = await registerUser('invitee');
    const ws = await seedWorkspace(owner.token);
    await seedMember(ws.id as WorkspaceId, owner.id as UserId, member.id as UserId);

    expect(
      (await post(`/workspaces/${UNKNOWN_ID}/invitations`, { inviteeId: invitee.id }, owner.token)).status,
    ).toBe(404);
    expect(
      (await post(`/workspaces/${ws.id}/invitations`, { inviteeId: invitee.id }, member.token)).status,
    ).toBe(403);
    expect(
      (await post(`/workspaces/${ws.id}/invitations`, { inviteeId: invitee.id }, stranger.token)).status,
    ).toBe(403);
    expect((await post(`/workspaces/${ws.id}/invitations`, { inviteeId: invitee.id })).status).toBe(401);
    expect((await post(`/workspaces/${UNKNOWN_ID}/invitations`, { inviteeId: invitee.id })).status).toBe(
      401,
    );
  });

  it('returns 409 when the invitee is already the owner or a member', async () => {
    const owner = await registerUser('owner');
    const member = await registerUser('member');
    const ws = await seedWorkspace(owner.token);
    await seedMember(ws.id as WorkspaceId, owner.id as UserId, member.id as UserId);

    expect(
      (await post(`/workspaces/${ws.id}/invitations`, { inviteeId: owner.id }, owner.token)).status,
    ).toBe(409);
    expect(
      (await post(`/workspaces/${ws.id}/invitations`, { inviteeId: member.id }, owner.token)).status,
    ).toBe(409);
  });

  it('returns 404 for a ghost invitee (well-formed UUID of a nonexistent user) and stores nothing', async () => {
    const owner = await registerUser('owner');
    const ws = await seedWorkspace(owner.token);
    const ghost = randomUUID();

    const res = await post(`/workspaces/${ws.id}/invitations`, { inviteeId: ghost }, owner.token);
    expect(res.status).toBe(404);

    // Nothing was stored: the ghost has no pending invitation.
    expect(await invitations.listPendingFor(ghost as UserId)).toEqual([]);
  });

  it('rejects invalid bodies with 400 without echoing submitted values (S14)', async () => {
    const owner = await registerUser('owner');
    const invitee = await registerUser('invitee');
    const ws = await seedWorkspace(owner.token);
    const path = `/workspaces/${ws.id}/invitations`;

    expect((await post(path, {}, owner.token)).status).toBe(400);
    expect((await post(path, { inviteeId: 42 }, owner.token)).status).toBe(400);
    expect((await post(path, { inviteeId: null }, owner.token)).status).toBe(400);
    expect((await post(path, { inviteeId: 'not-a-uuid' }, owner.token)).status).toBe(400);
    expect((await post(path, { inviteeId: invitee.id, extra: true }, owner.token)).status).toBe(400);

    // Field path only: the submitted value must never appear in the response.
    const leaked = 'definitely-not-a-user-zzz';
    const res = await post(path, { inviteeId: leaked }, owner.token);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(leaked);
    expect(JSON.stringify(res.body)).toContain('inviteeId');
  });
});

describe('POST /sessions/:id/invitations (S10)', () => {
  it('invites a user as guest and returns the session-target view (201)', async () => {
    const owner = await registerUser('owner');
    const invitee = await registerUser('invitee');
    const ws = await seedWorkspace(owner.token, 'team');
    const session = await seedSession(owner.token, ws.id, 'standup');

    const res = await post(`/sessions/${session.id}/invitations`, { inviteeId: invitee.id }, owner.token);
    expect(res.status).toBe(201);
    const body = res.body as InvitationBody;
    expect(Object.keys(body).sort()).toEqual(['id', 'invitedBy', 'target']);
    expect(body.target).toEqual({ kind: 'session', sessionId: session.id, name: 'standup' });
    expect(body.invitedBy.userId).toBe(owner.id);
  });

  it('returns 404 for an unknown session or a vanished workspace; 403 for member, stranger and guest; 401 without token', async () => {
    const owner = await registerUser('owner');
    const member = await registerUser('member');
    const stranger = await registerUser('stranger');
    const guest = await registerUser('guest');
    const invitee = await registerUser('invitee');
    const ws = await seedWorkspace(owner.token);
    const session = await seedSession(owner.token, ws.id);
    await seedMember(ws.id as WorkspaceId, owner.id as UserId, member.id as UserId);
    // Guest role via the invitations flow itself.
    const guestInvite = await post(
      `/sessions/${session.id}/invitations`,
      { inviteeId: guest.id },
      owner.token,
    );
    expect(guestInvite.status).toBe(201);
    expect(
      (await postEmpty(`/invitations/${(guestInvite.body as InvitationBody).id}/accept`, guest.token)).status,
    ).toBe(204);

    const path = `/sessions/${session.id}/invitations`;
    expect((await post(path, { inviteeId: invitee.id }, member.token)).status).toBe(403);
    expect((await post(path, { inviteeId: invitee.id }, stranger.token)).status).toBe(403);
    expect((await post(path, { inviteeId: invitee.id }, guest.token)).status).toBe(403);
    expect((await post(`/sessions/${UNKNOWN_ID}/invitations`, { inviteeId: invitee.id }, owner.token)).status).toBe(
      404,
    );
    // A ghost invitee (unknown user id) is 404 on the session path too.
    expect((await post(path, { inviteeId: randomUUID() }, owner.token)).status).toBe(404);
    expect((await post(path, { inviteeId: invitee.id })).status).toBe(401);

    // A session whose workspace is gone is 404 (workspaces cascade to sessions).
    await t.prisma.workspace.delete({ where: { id: ws.id } });
    expect((await post(path, { inviteeId: invitee.id }, owner.token)).status).toBe(404);
  });

  it('returns 409 when the invitee already has a role (owner, member, guest)', async () => {
    const owner = await registerUser('owner');
    const member = await registerUser('member');
    const guest = await registerUser('guest');
    const ws = await seedWorkspace(owner.token);
    const session = await seedSession(owner.token, ws.id);
    await seedMember(ws.id as WorkspaceId, owner.id as UserId, member.id as UserId);
    const path = `/sessions/${session.id}/invitations`;

    expect((await post(path, { inviteeId: owner.id }, owner.token)).status).toBe(409);
    expect((await post(path, { inviteeId: member.id }, owner.token)).status).toBe(409);

    const created = (await post(path, { inviteeId: guest.id }, owner.token)).body as InvitationBody;
    expect((await postEmpty(`/invitations/${created.id}/accept`, guest.token)).status).toBe(204);
    expect((await post(path, { inviteeId: guest.id }, owner.token)).status).toBe(409);
  });

  it('rejects invalid bodies with 400 without echoing submitted values (S14)', async () => {
    const owner = await registerUser('owner');
    const ws = await seedWorkspace(owner.token);
    const session = await seedSession(owner.token, ws.id);
    const path = `/sessions/${session.id}/invitations`;

    expect((await post(path, {}, owner.token)).status).toBe(400);
    expect((await post(path, { inviteeId: 'not-a-uuid' }, owner.token)).status).toBe(400);
    expect((await post(path, { inviteeId: randomUUID(), extra: 1 }, owner.token)).status).toBe(400);

    const leaked = 'definitely-not-a-user-zzz';
    const res = await post(path, { inviteeId: leaked }, owner.token);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(leaked);
    expect(JSON.stringify(res.body)).toContain('inviteeId');
  });
});

describe('GET /invitations (S11)', () => {
  it('lists the caller pending invitations with target and inviter (200)', async () => {
    const owner = await registerUser('owner');
    const invitee = await registerUser('invitee');
    const ws = await seedWorkspace(owner.token, 'team');
    const session = await seedSession(owner.token, ws.id, 'standup');

    const wsInvite = (
      await post(`/workspaces/${ws.id}/invitations`, { inviteeId: invitee.id }, owner.token)
    ).body as InvitationBody;
    const sessionInvite = (
      await post(`/sessions/${session.id}/invitations`, { inviteeId: invitee.id }, owner.token)
    ).body as InvitationBody;

    const res = await get('/invitations', invitee.token);
    expect(res.status).toBe(200);
    const list = res.body as InvitationBody[];
    expect(list).toHaveLength(2);
    const byId = new Map(list.map((entry) => [entry.id, entry]));
    expect(byId.get(wsInvite.id)?.target).toEqual({
      kind: 'workspace',
      workspaceId: ws.id,
      name: 'team',
    });
    expect(byId.get(sessionInvite.id)?.target).toEqual({
      kind: 'session',
      sessionId: session.id,
      name: 'standup',
    });
    for (const entry of list) {
      expect(entry.invitedBy).toEqual({
        userId: owner.id,
        username: owner.username,
        displayName: 'owner',
      });
    }

    // Another user sees none of them.
    expect(((await get('/invitations', owner.token)).body as unknown[])).toEqual([]);
  });

  it('excludes declined, accepted and expired invitations from the list', async () => {
    const owner = await registerUser('owner');
    const declined = await registerUser('declined');
    const accepted = await registerUser('accepted');
    const expired = await registerUser('expired');
    const ws = await seedWorkspace(owner.token);

    const declinedId = (
      await post(`/workspaces/${ws.id}/invitations`, { inviteeId: declined.id }, owner.token)
    ).body as InvitationBody;
    expect((await postEmpty(`/invitations/${declinedId.id}/decline`, declined.token)).status).toBe(204);

    const acceptedId = (
      await post(`/workspaces/${ws.id}/invitations`, { inviteeId: accepted.id }, owner.token)
    ).body as InvitationBody;
    expect((await postEmpty(`/invitations/${acceptedId.id}/accept`, accepted.token)).status).toBe(204);

    await seedExpiredWorkspaceInvitation(ws.id as WorkspaceId, owner.id as UserId, expired.id as UserId);

    expect(((await get('/invitations', declined.token)).body as unknown[])).toEqual([]);
    expect(((await get('/invitations', accepted.token)).body as unknown[])).toEqual([]);
    expect(((await get('/invitations', expired.token)).body as unknown[])).toEqual([]);
  });

  it('hides entries whose target aggregate no longer exists', async () => {
    const owner = await registerUser('owner');
    const invitee = await registerUser('invitee');
    const ws = await seedWorkspace(owner.token);
    await post(`/workspaces/${ws.id}/invitations`, { inviteeId: invitee.id }, owner.token);
    expect(((await get('/invitations', invitee.token)).body as unknown[])).toHaveLength(1);

    // Workspaces cascade to their invitations, so the entry disappears with it.
    await t.prisma.workspace.delete({ where: { id: ws.id } });
    expect(((await get('/invitations', invitee.token)).body as unknown[])).toEqual([]);
  });

  it('requires auth (401)', async () => {
    expect((await get('/invitations')).status).toBe(401);
  });
});

describe('POST /invitations/:id/accept (S12)', () => {
  it('workspace invitee accepts (204), becomes a member, invitation marked accepted', async () => {
    const owner = await registerUser('owner');
    const invitee = await registerUser('invitee');
    const ws = await seedWorkspace(owner.token);
    const created = (
      await post(`/workspaces/${ws.id}/invitations`, { inviteeId: invitee.id }, owner.token)
    ).body as InvitationBody;

    const res = await postEmpty(`/invitations/${created.id}/accept`, invitee.token);
    expect(res.status).toBe(204);
    expect(res.body).toBeUndefined();

    // Membership applied: the invitee now sees the workspace detail as a member.
    const detail = (await get(`/workspaces/${ws.id}`, invitee.token)).body as {
      members: { userId: string }[];
    };
    expect(detail.members.map((m) => m.userId)).toContain(invitee.id);

    // Invitation marked accepted (S15: aggregate change and status stay together).
    expect((await invitations.find(created.id as InvitationId))?.status).toBe('accepted');
  });

  it('session invitee accepts (204) and can then view the session', async () => {
    const owner = await registerUser('owner');
    const invitee = await registerUser('invitee');
    const stranger = await registerUser('stranger');
    const ws = await seedWorkspace(owner.token);
    const session = await seedSession(owner.token, ws.id);
    expect((await get(`/sessions/${session.id}`, invitee.token)).status).toBe(403);

    const created = (
      await post(`/sessions/${session.id}/invitations`, { inviteeId: invitee.id }, owner.token)
    ).body as InvitationBody;
    expect((await postEmpty(`/invitations/${created.id}/accept`, invitee.token)).status).toBe(204);
    expect((await get(`/sessions/${session.id}`, invitee.token)).status).toBe(200);
    expect((await get(`/sessions/${session.id}`, stranger.token)).status).toBe(403);
  });

  it('returns 404 for unknown and malformed ids (never 500)', async () => {
    const user = await registerUser('user');
    expect((await postEmpty(`/invitations/${UNKNOWN_ID}/accept`, user.token)).status).toBe(404);
    expect((await postEmpty('/invitations/not-a-uuid/accept', user.token)).status).toBe(404);
  });

  it('returns 403 for non-invitees before any status signal (no leak)', async () => {
    const owner = await registerUser('owner');
    const invitee = await registerUser('invitee');
    const stranger = await registerUser('stranger');
    const ws = await seedWorkspace(owner.token);
    const created = (
      await post(`/workspaces/${ws.id}/invitations`, { inviteeId: invitee.id }, owner.token)
    ).body as InvitationBody;

    // Pending invitation, stranger probes: 403, not 404/409.
    expect((await postEmpty(`/invitations/${created.id}/accept`, stranger.token)).status).toBe(403);
    expect((await postEmpty(`/invitations/${created.id}/decline`, stranger.token)).status).toBe(403);

    // After the invitee accepts, the stranger still gets 403 (no status leak).
    expect((await postEmpty(`/invitations/${created.id}/accept`, invitee.token)).status).toBe(204);
    expect((await postEmpty(`/invitations/${created.id}/accept`, stranger.token)).status).toBe(403);
    expect((await postEmpty(`/invitations/${created.id}/accept`, owner.token)).status).toBe(403);
  });

  it('returns 409 for already-responded and expired invitations without changing them', async () => {
    const owner = await registerUser('owner');
    const twice = await registerUser('twice');
    const declined = await registerUser('declined');
    const expired = await registerUser('expired');
    const ws = await seedWorkspace(owner.token);

    const twiceId = (
      await post(`/workspaces/${ws.id}/invitations`, { inviteeId: twice.id }, owner.token)
    ).body as InvitationBody;
    expect((await postEmpty(`/invitations/${twiceId.id}/accept`, twice.token)).status).toBe(204);
    expect((await postEmpty(`/invitations/${twiceId.id}/accept`, twice.token)).status).toBe(409);
    expect((await invitations.find(twiceId.id as InvitationId))?.status).toBe('accepted');

    const declinedId = (
      await post(`/workspaces/${ws.id}/invitations`, { inviteeId: declined.id }, owner.token)
    ).body as InvitationBody;
    expect((await postEmpty(`/invitations/${declinedId.id}/decline`, declined.token)).status).toBe(204);
    expect((await postEmpty(`/invitations/${declinedId.id}/accept`, declined.token)).status).toBe(409);
    expect((await invitations.find(declinedId.id as InvitationId))?.status).toBe('declined');

    const expiredId = await seedExpiredWorkspaceInvitation(
      ws.id as WorkspaceId,
      owner.id as UserId,
      expired.id as UserId,
    );
    expect((await postEmpty(`/invitations/${expiredId}/accept`, expired.token)).status).toBe(409);
    expect((await invitations.find(expiredId as InvitationId))?.status).toBe('pending');
  });

  it('returns 409 and leaves the invitation pending when the invitee is already a member (failed accept never applies)', async () => {
    const owner = await registerUser('owner');
    const invitee = await registerUser('invitee');
    const ws = await seedWorkspace(owner.token);
    const created = (
      await post(`/workspaces/${ws.id}/invitations`, { inviteeId: invitee.id }, owner.token)
    ).body as InvitationBody;

    // The invitee gains membership through another path before accepting.
    await seedMember(ws.id as WorkspaceId, owner.id as UserId, invitee.id as UserId);

    expect((await postEmpty(`/invitations/${created.id}/accept`, invitee.token)).status).toBe(409);
    // A failed accept never marks the invitation accepted (S15).
    expect((await invitations.find(created.id as InvitationId))?.status).toBe('pending');
  });

  it('returns 404 when the target aggregate is gone', async () => {
    const owner = await registerUser('owner');
    const invitee = await registerUser('invitee');
    const ws = await seedWorkspace(owner.token);
    const created = (
      await post(`/workspaces/${ws.id}/invitations`, { inviteeId: invitee.id }, owner.token)
    ).body as InvitationBody;

    await t.prisma.workspace.delete({ where: { id: ws.id } });
    expect((await postEmpty(`/invitations/${created.id}/accept`, invitee.token)).status).toBe(404);
  });

  it('requires auth (401)', async () => {
    const owner = await registerUser('owner');
    const invitee = await registerUser('invitee');
    const ws = await seedWorkspace(owner.token);
    const created = (
      await post(`/workspaces/${ws.id}/invitations`, { inviteeId: invitee.id }, owner.token)
    ).body as InvitationBody;

    expect((await postEmpty(`/invitations/${created.id}/accept`)).status).toBe(401);
    expect((await postEmpty('/invitations/not-a-uuid/accept')).status).toBe(401);
  });
});

describe('POST /invitations/:id/decline (S13)', () => {
  it('invitee declines (204): invitation marked declined and hidden from the list', async () => {
    const owner = await registerUser('owner');
    const invitee = await registerUser('invitee');
    const ws = await seedWorkspace(owner.token);
    const created = (
      await post(`/workspaces/${ws.id}/invitations`, { inviteeId: invitee.id }, owner.token)
    ).body as InvitationBody;
    expect(((await get('/invitations', invitee.token)).body as unknown[])).toHaveLength(1);

    const res = await postEmpty(`/invitations/${created.id}/decline`, invitee.token);
    expect(res.status).toBe(204);
    expect(res.body).toBeUndefined();
    expect((await invitations.find(created.id as InvitationId))?.status).toBe('declined');
    expect(((await get('/invitations', invitee.token)).body as unknown[])).toEqual([]);

    // Declining grants nothing: the invitee still cannot see the workspace.
    expect((await get(`/workspaces/${ws.id}`, invitee.token)).status).toBe(403);
  });

  it('returns 409 on double decline and on accept-after-decline', async () => {
    const owner = await registerUser('owner');
    const invitee = await registerUser('invitee');
    const ws = await seedWorkspace(owner.token);
    const created = (
      await post(`/workspaces/${ws.id}/invitations`, { inviteeId: invitee.id }, owner.token)
    ).body as InvitationBody;

    expect((await postEmpty(`/invitations/${created.id}/decline`, invitee.token)).status).toBe(204);
    expect((await postEmpty(`/invitations/${created.id}/decline`, invitee.token)).status).toBe(409);
    expect((await postEmpty(`/invitations/${created.id}/accept`, invitee.token)).status).toBe(409);
    expect((await invitations.find(created.id as InvitationId))?.status).toBe('declined');
  });

  it('returns 403 for non-invitees, 404 for unknown/malformed ids, 401 without token', async () => {
    const owner = await registerUser('owner');
    const invitee = await registerUser('invitee');
    const stranger = await registerUser('stranger');
    const ws = await seedWorkspace(owner.token);
    const created = (
      await post(`/workspaces/${ws.id}/invitations`, { inviteeId: invitee.id }, owner.token)
    ).body as InvitationBody;

    expect((await postEmpty(`/invitations/${created.id}/decline`, stranger.token)).status).toBe(403);
    expect((await postEmpty(`/invitations/${UNKNOWN_ID}/decline`, invitee.token)).status).toBe(404);
    expect((await postEmpty('/invitations/not-a-uuid/decline', invitee.token)).status).toBe(404);
    expect((await postEmpty(`/invitations/${created.id}/decline`)).status).toBe(401);
    expect((await get('/invitations')).status).toBe(401);
    expect((await post(`/workspaces/${ws.id}/invitations`, { inviteeId: invitee.id })).status).toBe(401);
  });
});
