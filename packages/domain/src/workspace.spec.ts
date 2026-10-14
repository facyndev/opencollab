import { describe, expect, it } from 'vitest';

import { newUserId, newWorkspaceId } from './ids';
import { expectDomainError } from './test-helpers';
import { Workspace } from './workspace';

describe('Workspace', () => {
  it('only owner adds members', () => {
    const owner = newUserId();
    const other = newUserId();
    const ws = new Workspace(owner, 'proyecto');
    expectDomainError(() => ws.addMember(other, newUserId()), { code: 'NotOwner' });
    ws.addMember(owner, other);
    expect(ws.isMember(other)).toBe(true);
  });

  it('accepting workspace invitation adds member', () => {
    const owner = newUserId();
    const invitee = newUserId();
    const ws = new Workspace(owner, 'proyecto');
    const inv = ws.inviteMember(owner, invitee);
    ws.acceptInvitation(inv);
    expect(ws.isMember(invitee)).toBe(true);
  });

  it('non owner cannot invite', () => {
    const owner = newUserId();
    const member = newUserId();
    const ws = new Workspace(owner, 'proyecto');
    ws.addMember(owner, member);
    expectDomainError(() => ws.inviteMember(member, newUserId()), { code: 'NotOwner' });
  });

  it('owner and existing members already have access', () => {
    const owner = newUserId();
    const member = newUserId();
    const ws = new Workspace(owner, 'p');
    ws.addMember(owner, member);
    expectDomainError(() => ws.addMember(owner, owner), { code: 'AlreadyHasAccess', user: owner });
    expectDomainError(() => ws.addMember(owner, member), { code: 'AlreadyHasAccess', user: member });
    expectDomainError(() => ws.inviteMember(owner, member), { code: 'AlreadyHasAccess', user: member });
    expect(ws.members.map((m) => m.userId)).toEqual([member]);
  });

  it('removes members, only the owner, and only actual members', () => {
    const owner = newUserId();
    const member = newUserId();
    const ws = new Workspace(owner, 'p');
    ws.addMember(owner, member);
    expectDomainError(() => ws.removeMember(member, member), { code: 'NotOwner' });
    ws.removeMember(owner, member);
    expect(ws.isMember(member)).toBe(false);
    expectDomainError(() => ws.removeMember(owner, member), { code: 'NotAParticipant', user: member });
  });

  it('rejects an invitation aimed at another target', () => {
    const owner = newUserId();
    const a = new Workspace(owner, 'a');
    const b = new Workspace(owner, 'b');
    const inv = a.inviteMember(owner, newUserId());
    expectDomainError(() => b.acceptInvitation(inv), { code: 'InvitationTargetMismatch' });
  });

  it('restore rebuilds persisted state without creation-time checks', () => {
    const id = newWorkspaceId();
    const owner = newUserId();
    const member = newUserId();
    const ws = Workspace.restore({ id, owner, name: 'proyecto', members: [member] });
    expect(ws.id).toBe(id);
    expect(ws.owner).toBe(owner);
    expect(ws.name).toBe('proyecto');
    expect(ws.isMember(member)).toBe(true);
    expect(ws.members).toEqual([{ userId: member }]);
  });

  it('restored workspace keeps enforcing owner rules', () => {
    const owner = newUserId();
    const ws = Workspace.restore({ id: newWorkspaceId(), owner, name: 'p', members: [] });
    expectDomainError(() => ws.addMember(newUserId(), newUserId()), { code: 'NotOwner' });
    const invitee = newUserId();
    ws.addMember(owner, invitee);
    expect(ws.isMember(invitee)).toBe(true);
  });
});
