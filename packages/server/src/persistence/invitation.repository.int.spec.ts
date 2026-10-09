import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Session, Workspace, newInvitationId } from '../domain';
import type { PrismaClient } from '../generated/prisma/client';
import { InvitationRepository } from './invitation.repository';
import { SessionRepository } from './session.repository';
import { openTestClient, truncateAll } from './test-db';
import { seedUser } from './test-fixtures';
import { UserRepository } from './user.repository';
import { WorkspaceRepository } from './workspace.repository';

describe('InvitationRepository', () => {
  let prisma: PrismaClient;
  let users: UserRepository;
  let invitations: InvitationRepository;

  beforeAll(() => {
    prisma = openTestClient();
    users = new UserRepository(prisma);
    invitations = new InvitationRepository(prisma);
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  async function fixture() {
    const owner = await seedUser(users);
    const invitee = await seedUser(users);
    const workspace = new Workspace(owner, 'proyecto');
    await new WorkspaceRepository(prisma).save(workspace);
    const session = Session.create(workspace, owner, 's');
    await new SessionRepository(prisma).save(session);
    return { owner, invitee, workspace, session };
  }

  it('saves and finds a workspace invitation as pending', async () => {
    const f = await fixture();
    const invitation = f.workspace.inviteMember(f.owner, f.invitee);
    const expiresAt = new Date(Date.now() + 3_600_000);
    await invitations.save(invitation, expiresAt);

    const stored = await invitations.find(invitation.id);
    expect(stored?.invitation).toEqual(invitation);
    expect(stored?.status).toBe('pending');
    expect(stored?.expiresAt?.getTime()).toBe(expiresAt.getTime());
    expect(stored?.respondedAt).toBeNull();
  });

  it('saves a session invitation', async () => {
    const f = await fixture();
    const invitation = f.session.inviteGuest(f.workspace, f.owner, f.invitee);
    await invitations.save(invitation);
    const stored = await invitations.find(invitation.id);
    expect(stored?.invitation).toEqual(invitation);
    expect(stored?.expiresAt).toBeNull();
  });

  it('lists only pending invitations for the invitee', async () => {
    const f = await fixture();
    const first = f.workspace.inviteMember(f.owner, f.invitee);
    const second = f.session.inviteGuest(f.workspace, f.owner, f.invitee);
    const unrelated = f.workspace.inviteMember(f.owner, await seedUser(users));
    await invitations.save(first);
    await invitations.save(second);
    await invitations.save(unrelated);
    await invitations.setStatus(first.id, 'declined');

    const pending = await invitations.listPendingFor(f.invitee);
    expect(pending.map((p) => p.invitation.id)).toEqual([second.id]);
  });

  it('excludes expired invitations from the pending list', async () => {
    const f = await fixture();
    const live = f.workspace.inviteMember(f.owner, f.invitee);
    const expired = f.session.inviteGuest(f.workspace, f.owner, f.invitee);
    await invitations.save(live, new Date(Date.now() + 3_600_000));
    await invitations.save(expired, new Date(Date.now() - 1_000));

    const pending = await invitations.listPendingFor(f.invitee);
    expect(pending.map((p) => p.invitation.id)).toEqual([live.id]);
    const later = new Date(Date.now() + 2 * 3_600_000);
    expect(await invitations.listPendingFor(f.invitee, later)).toEqual([]);
  });

  it('setStatus only transitions from pending', async () => {
    const f = await fixture();
    const invitation = f.workspace.inviteMember(f.owner, f.invitee);
    await invitations.save(invitation);
    await invitations.setStatus(invitation.id, 'accepted');
    await expect(invitations.setStatus(invitation.id, 'revoked')).rejects.toThrow(/pending/);
    expect((await invitations.find(invitation.id))?.status).toBe('accepted');
  });

  it('setStatus rejects an unknown invitation and a pending target', async () => {
    const f = await fixture();
    await expect(invitations.setStatus(newInvitationId(), 'accepted')).rejects.toThrow();
    const invitation = f.workspace.inviteMember(f.owner, f.invitee);
    await invitations.save(invitation);
    await expect(invitations.setStatus(invitation.id, 'pending' as 'accepted')).rejects.toThrow();
  });

  it('setStatus records the response time', async () => {
    const f = await fixture();
    const invitation = f.workspace.inviteMember(f.owner, f.invitee);
    await invitations.save(invitation);
    await invitations.setStatus(invitation.id, 'accepted');
    const stored = await invitations.find(invitation.id);
    expect(stored?.status).toBe('accepted');
    expect(stored?.respondedAt).toBeInstanceOf(Date);
  });

  it('returns undefined for an unknown invitation', async () => {
    expect(await invitations.find(newInvitationId())).toBeUndefined();
  });

  describe('target CHECK constraint', () => {
    it('rejects a row with neither target', async () => {
      const f = await fixture();
      await expect(
        prisma.$executeRaw`
          INSERT INTO "Invitation" ("id", "kind", "inviteeId", "invitedById")
          VALUES (${randomUUID()}::uuid, 'WORKSPACE', ${f.invitee}::uuid, ${f.owner}::uuid)`,
      ).rejects.toThrow(/Invitation_target_matches_kind/);
    });

    it('rejects a row with both targets', async () => {
      const f = await fixture();
      await expect(
        prisma.$executeRaw`
          INSERT INTO "Invitation" ("id", "kind", "workspaceId", "sessionId", "inviteeId", "invitedById")
          VALUES (${randomUUID()}::uuid, 'WORKSPACE', ${f.workspace.id}::uuid, ${f.session.id}::uuid,
                  ${f.invitee}::uuid, ${f.owner}::uuid)`,
      ).rejects.toThrow(/Invitation_target_matches_kind/);
    });

    it('rejects a target that does not match the kind', async () => {
      const f = await fixture();
      await expect(
        prisma.$executeRaw`
          INSERT INTO "Invitation" ("id", "kind", "workspaceId", "inviteeId", "invitedById")
          VALUES (${randomUUID()}::uuid, 'SESSION', ${f.workspace.id}::uuid,
                  ${f.invitee}::uuid, ${f.owner}::uuid)`,
      ).rejects.toThrow(/Invitation_target_matches_kind/);
    });
  });
});
