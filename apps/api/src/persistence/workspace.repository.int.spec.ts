import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Session, Workspace, newAgentProfile, newWorkspaceId } from '@opencollab/domain';
import type { PrismaClient } from '../generated/prisma/client';
import { SessionRepository } from './session.repository';
import { openTestClient, truncateAll } from './test-db';
import { seedUser } from './test-fixtures';
import { UserRepository } from './user.repository';
import { WorkspaceRepository } from './workspace.repository';

describe('WorkspaceRepository', () => {
  let prisma: PrismaClient;
  let users: UserRepository;
  let workspaces: WorkspaceRepository;

  beforeAll(() => {
    prisma = openTestClient();
    users = new UserRepository(prisma);
    workspaces = new WorkspaceRepository(prisma);
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('round-trips the aggregate keeping its id', async () => {
    const owner = await seedUser(users);
    const a = await seedUser(users);
    const b = await seedUser(users);
    const ws = new Workspace(owner, 'proyecto');
    ws.addMember(owner, a);
    ws.addMember(owner, b);
    await workspaces.save(ws);

    const loaded = await workspaces.find(ws.id);
    expect(loaded?.id).toBe(ws.id);
    expect(loaded?.owner).toBe(owner);
    expect(loaded?.name).toBe('proyecto');
    expect(loaded?.members.map((m) => m.userId).sort()).toEqual([a, b].sort());
  });

  it('returns undefined for an unknown workspace', async () => {
    expect(await workspaces.find(newWorkspaceId())).toBeUndefined();
  });

  it('save replaces the member set', async () => {
    const owner = await seedUser(users);
    const a = await seedUser(users);
    const b = await seedUser(users);
    const ws = new Workspace(owner, 'proyecto');
    ws.addMember(owner, a);
    await workspaces.save(ws);

    ws.removeMember(owner, a);
    ws.addMember(owner, b);
    await workspaces.save(ws);

    const loaded = await workspaces.find(ws.id);
    expect(loaded?.members.map((m) => m.userId)).toEqual([b]);
  });

  it('save is idempotent', async () => {
    const owner = await seedUser(users);
    const a = await seedUser(users);
    const ws = new Workspace(owner, 'proyecto');
    ws.addMember(owner, a);
    await workspaces.save(ws);
    await workspaces.save(ws);
    expect((await workspaces.find(ws.id))?.members).toHaveLength(1);
  });

  it('listForUser returns workspaces where the user is owner or member, and not others', async () => {
    const owner = await seedUser(users);
    const member = await seedUser(users);
    const stranger = await seedUser(users);
    const otherOwner = await seedUser(users);

    const mine = new Workspace(owner, 'mine');
    mine.addMember(owner, member);
    await workspaces.save(mine);

    const shared = new Workspace(member, 'shared');
    await workspaces.save(shared);

    const foreign = new Workspace(otherOwner, 'foreign');
    await workspaces.save(foreign);

    // `mine` is owned by owner with member added; `shared` is owned by member only.
    const forOwner = await workspaces.listForUser(owner);
    expect(forOwner.map((w) => w.id)).toEqual([mine.id]);

    const forMember = await workspaces.listForUser(member);
    expect(forMember.map((w) => w.id).sort()).toEqual([mine.id, shared.id].sort());

    const forStranger = await workspaces.listForUser(stranger);
    expect(forStranger).toEqual([]);
  });

  it('deleting a workspace cascades to members, sessions and their children', async () => {
    const owner = await seedUser(users);
    const member = await seedUser(users);
    const guest = await seedUser(users);
    const ws = new Workspace(owner, 'proyecto');
    ws.addMember(owner, member);
    await workspaces.save(ws);

    const sessions = new SessionRepository(prisma);
    const session = Session.create(ws, owner, 's');
    session.addTerminal(ws, owner, newAgentProfile('shell', 'sh'));
    session.setAccess(ws, owner, member, 'none');
    session.acceptInvitation(ws, session.inviteGuest(ws, owner, guest));
    await sessions.save(session);

    await prisma.workspace.delete({ where: { id: ws.id } });

    expect(await prisma.workspaceMember.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
    expect(await prisma.terminal.count()).toBe(0);
    expect(await prisma.sessionAccessOverride.count()).toBe(0);
    expect(await prisma.sessionGuest.count()).toBe(0);
    expect(await prisma.user.count()).toBe(3);
  });
});
