import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Session, Workspace, newSessionId } from '../domain';
import type { PrismaClient } from '../generated/prisma/client';
import { RepositorySessionStore } from './session-store';
import { SessionRepository } from './session.repository';
import { openTestClient, truncateAll } from './test-db';
import { seedUser } from './test-fixtures';
import { UserRepository } from './user.repository';
import { WorkspaceRepository } from './workspace.repository';

describe('RepositorySessionStore', () => {
  let prisma: PrismaClient;
  let users: UserRepository;
  let workspaces: WorkspaceRepository;
  let sessions: SessionRepository;
  let store: RepositorySessionStore;

  beforeAll(() => {
    prisma = openTestClient();
    users = new UserRepository(prisma);
    workspaces = new WorkspaceRepository(prisma);
    sessions = new SessionRepository(prisma);
    store = new RepositorySessionStore(sessions, workspaces);
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  it('loads a session together with its workspace', async () => {
    const owner = await seedUser(users);
    const member = await seedUser(users);
    const workspace = new Workspace(owner, 'w');
    workspace.addMember(owner, member);
    await workspaces.save(workspace);
    const session = Session.create(workspace, owner, 's');
    await sessions.save(session);

    const loaded = await store.load(session.id);
    expect(loaded?.session.id).toBe(session.id);
    expect(loaded?.workspace.isOwner(owner)).toBe(true);
    expect(loaded?.workspace.isMember(member)).toBe(true);
  });

  it('answers undefined for an unknown session', async () => {
    expect(await store.load(newSessionId())).toBeUndefined();
  });

  it('persists access changes through save', async () => {
    const owner = await seedUser(users);
    const member = await seedUser(users);
    const workspace = new Workspace(owner, 'w');
    workspace.addMember(owner, member);
    await workspaces.save(workspace);
    const session = Session.create(workspace, owner, 's');
    await sessions.save(session);

    const loaded = await store.load(session.id);
    loaded!.session.setAccess(loaded!.workspace, owner, member, 'write');
    await store.save(loaded!.session);

    const again = await store.load(session.id);
    expect(again!.session.accessOf(again!.workspace, member)).toBe('write');
  });
});
