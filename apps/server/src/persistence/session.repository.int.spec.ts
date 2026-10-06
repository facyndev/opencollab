import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Session, Workspace, newAgentProfile, newSessionId } from '../domain';
import type { PrismaClient } from '../generated/prisma/client';
import { SessionRepository } from './session.repository';
import { openTestClient, truncateAll } from './test-db';
import { seedUser } from './test-fixtures';
import { UserRepository } from './user.repository';
import { WorkspaceRepository } from './workspace.repository';

describe('SessionRepository', () => {
  let prisma: PrismaClient;
  let users: UserRepository;
  let workspaces: WorkspaceRepository;
  let sessions: SessionRepository;

  beforeAll(() => {
    prisma = openTestClient();
    users = new UserRepository(prisma);
    workspaces = new WorkspaceRepository(prisma);
    sessions = new SessionRepository(prisma);
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => truncateAll(prisma));

  async function fixture() {
    const owner = await seedUser(users);
    const member = await seedUser(users);
    const guest = await seedUser(users);
    const workspace = new Workspace(owner, 'proyecto');
    workspace.addMember(owner, member);
    await workspaces.save(workspace);
    const session = Session.create(workspace, owner, 'sesión');
    return { owner, member, guest, workspace, session };
  }

  it('round-trips terminals in order, overrides (including none) and guests', async () => {
    const f = await fixture();
    const other = await seedUser(users);
    f.workspace.addMember(f.owner, other);
    await workspaces.save(f.workspace);
    const t1 = f.session.addTerminal(
      f.workspace,
      f.owner,
      newAgentProfile('a', 'sh', { args: ['-l'], cwd: '/tmp' }),
    );
    const t2 = f.session.addTerminal(f.workspace, f.owner, newAgentProfile('b', 'zsh'));
    const t3 = f.session.addTerminal(f.workspace, f.owner, newAgentProfile('c', 'fish'));
    f.session.setAccess(f.workspace, f.owner, f.member, 'none');
    f.session.setAccess(f.workspace, f.owner, other, 'write');
    f.session.acceptInvitation(f.workspace, f.session.inviteGuest(f.workspace, f.owner, f.guest));
    f.session.setAccess(f.workspace, f.owner, f.guest, 'write');
    await sessions.save(f.session);

    const loaded = await sessions.find(f.session.id);
    expect(loaded?.id).toBe(f.session.id);
    expect(loaded?.workspaceId).toBe(f.workspace.id);
    expect(loaded?.name).toBe('sesión');
    expect(loaded?.terminals.map((t) => t.id)).toEqual([t1, t2, t3]);
    expect(loaded?.terminals[0].profile).toEqual({
      name: 'a',
      command: 'sh',
      args: ['-l'],
      env: [],
      cwd: '/tmp',
    });
    expect(loaded?.terminals[1].profile).toEqual({ name: 'b', command: 'zsh', args: [], env: [] });
    expect(loaded?.accessOf(f.workspace, f.member)).toBe('none');
    expect(loaded?.accessOf(f.workspace, other)).toBe('write');
    expect(loaded?.accessOf(f.workspace, f.guest)).toBe('write');
    expect(loaded?.accessOf(f.workspace, f.owner)).toBe('write');
  });

  it('a member with no override row resolves view after reload (lazy default)', async () => {
    const f = await fixture();
    await sessions.save(f.session);
    expect(await prisma.sessionAccessOverride.count()).toBe(0);
    const loaded = await sessions.find(f.session.id);
    expect(loaded?.accessOf(f.workspace, f.member)).toBe('view');
  });

  it('persists only explicit overrides, never effective access', async () => {
    const f = await fixture();
    f.session.setAccess(f.workspace, f.owner, f.member, 'write');
    await sessions.save(f.session);
    expect(await prisma.sessionAccessOverride.count()).toBe(1);
  });

  it('never persists terminal env', async () => {
    const f = await fixture();
    f.session.addTerminal(
      f.workspace,
      f.owner,
      newAgentProfile('a', 'sh', { env: [['API_KEY', 'secret']] }),
    );
    await sessions.save(f.session);
    const rows = await prisma.terminal.findMany();
    expect(rows[0].env).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain('secret');
    const loaded = await sessions.find(f.session.id);
    expect(loaded?.terminals[0].profile.env).toEqual([]);
  });

  it('save replaces terminals and overrides', async () => {
    const f = await fixture();
    const t1 = f.session.addTerminal(f.workspace, f.owner, newAgentProfile('a', 'sh'));
    const t2 = f.session.addTerminal(f.workspace, f.owner, newAgentProfile('b', 'sh'));
    f.session.setAccess(f.workspace, f.owner, f.member, 'none');
    await sessions.save(f.session);

    f.session.removeTerminal(f.workspace, f.owner, t1);
    f.session.setAccess(f.workspace, f.owner, f.member, 'write');
    await sessions.save(f.session);

    const loaded = await sessions.find(f.session.id);
    expect(loaded?.terminals.map((t) => t.id)).toEqual([t2]);
    expect(loaded?.accessOf(f.workspace, f.member)).toBe('write');
    expect(await prisma.terminal.count()).toBe(1);
  });

  it('returns undefined for an unknown session', async () => {
    expect(await sessions.find(newSessionId())).toBeUndefined();
  });

  it('lists the sessions of a workspace', async () => {
    const f = await fixture();
    const second = Session.create(f.workspace, f.owner, 'otra');
    await sessions.save(f.session);
    await sessions.save(second);
    const listed = await sessions.listByWorkspace(f.workspace.id);
    expect(listed.map((s) => s.id).sort()).toEqual([f.session.id, second.id].sort());
  });
});
