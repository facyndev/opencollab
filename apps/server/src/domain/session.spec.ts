import { describe, expect, it } from 'vitest';

import { newUserId, type UserId } from './ids';
import { Session } from './session';
import { newAgentProfile } from './terminal';
import { expectDomainError } from './test-helpers';
import { Workspace } from './workspace';

function fixture() {
  const owner = newUserId();
  const member = newUserId();
  const workspace = new Workspace(owner, 'proyecto');
  workspace.addMember(owner, member);
  const session = Session.create(workspace, owner, 'sesión');
  return { owner, member, workspace, session };
}
type Fixture = ReturnType<typeof fixture>;

function withGuest(f: Fixture): UserId {
  const guest = newUserId();
  const inv = f.session.inviteGuest(f.workspace, f.owner, guest);
  f.session.acceptInvitation(f.workspace, inv);
  return guest;
}

describe('Session', () => {
  it('only owner removes terminals', () => {
    const f = fixture();
    const terminal = f.session.addTerminal(f.workspace, f.owner, newAgentProfile('shell', 'sh'));
    expectDomainError(() => f.session.removeTerminal(f.workspace, f.member, terminal), {
      code: 'NotOwner',
    });
    f.session.removeTerminal(f.workspace, f.owner, terminal);
    expect(f.session.terminal(terminal)).toBeUndefined();
    expectDomainError(() => f.session.removeTerminal(f.workspace, f.owner, terminal), {
      code: 'TerminalNotInSession',
      terminal,
    });
  });

  it('only owner adds terminals, keeping order', () => {
    const f = fixture();
    expectDomainError(
      () => f.session.addTerminal(f.workspace, f.member, newAgentProfile('s', 'sh')),
      { code: 'NotOwner' },
    );
    const a = f.session.addTerminal(f.workspace, f.owner, newAgentProfile('a', 'sh'));
    const b = f.session.addTerminal(f.workspace, f.owner, newAgentProfile('b', 'sh'));
    expect(f.session.terminals.map((t) => t.id)).toEqual([a, b]);
  });

  it('member starts with view by default', () => {
    const f = fixture();
    expect(f.session.accessOf(f.workspace, f.member)).toBe('view');
    expect(f.session.canView(f.workspace, f.member)).toBe(true);
    expect(f.session.canWrite(f.workspace, f.member)).toBe(false);
  });

  it('member added after session creation also gets view', () => {
    const f = fixture();
    const late = newUserId();
    f.workspace.addMember(f.owner, late);
    expect(f.session.accessOf(f.workspace, late)).toBe('view');
  });

  it('guest starts with view', () => {
    const f = fixture();
    const guest = withGuest(f);
    expect(f.session.accessOf(f.workspace, guest)).toBe('view');
  });

  it('enabling write enables view', () => {
    const f = fixture();
    f.session.setView(f.workspace, f.owner, f.member, false);
    const level = f.session.setWrite(f.workspace, f.owner, f.member, true);
    expect(level).toBe('write');
    expect(f.session.canView(f.workspace, f.member)).toBe(true);
    expect(f.session.canWrite(f.workspace, f.member)).toBe(true);
  });

  it('no participant can write without view', () => {
    const f = fixture();
    const guest = withGuest(f);
    for (const user of [f.owner, f.member, guest]) {
      for (const [view, write] of [
        [true, true],
        [false, true],
        [true, false],
        [false, false],
      ] as const) {
        if (user !== f.owner) {
          f.session.setWrite(f.workspace, f.owner, user, write);
          f.session.setView(f.workspace, f.owner, user, view);
        }
        if (f.session.canWrite(f.workspace, user)) {
          expect(f.session.canView(f.workspace, user)).toBe(true);
        }
      }
    }
  });

  it('removing view revokes write and access', () => {
    const f = fixture();
    f.session.setWrite(f.workspace, f.owner, f.member, true);
    f.session.setView(f.workspace, f.owner, f.member, false);
    expect(f.session.accessOf(f.workspace, f.member)).toBe('none');
    expect(f.session.canView(f.workspace, f.member)).toBe(false);
    expect(f.session.canWrite(f.workspace, f.member)).toBe(false);
  });

  it('removing view for guest revokes access', () => {
    const f = fixture();
    const guest = withGuest(f);
    f.session.setView(f.workspace, f.owner, guest, false);
    expect(f.session.canView(f.workspace, guest)).toBe(false);
  });

  it('view override is per session', () => {
    const f = fixture();
    const other = Session.create(f.workspace, f.owner, 'otra');
    f.session.setView(f.workspace, f.owner, f.member, false);
    expect(f.session.canView(f.workspace, f.member)).toBe(false);
    expect(other.canView(f.workspace, f.member)).toBe(true);
  });

  it('guest cannot see other sessions of the workspace', () => {
    const f = fixture();
    const guest = withGuest(f);
    const other = Session.create(f.workspace, f.owner, 'otra');
    expect(f.session.canView(f.workspace, guest)).toBe(true);
    expect(other.canView(f.workspace, guest)).toBe(false);
    expect(f.workspace.isMember(guest)).toBe(false);
  });

  it('only owner can change permissions', () => {
    const f = fixture();
    const guest = withGuest(f);
    expectDomainError(() => f.session.setWrite(f.workspace, f.member, guest, true), {
      code: 'NotOwner',
    });
    expectDomainError(() => f.session.setView(f.workspace, guest, f.member, false), {
      code: 'NotOwner',
    });
    expect(f.session.accessOf(f.workspace, guest)).toBe('view');
    expect(f.session.accessOf(f.workspace, f.member)).toBe('view');
  });

  it('owner always has full access', () => {
    const f = fixture();
    expect(f.session.accessOf(f.workspace, f.owner)).toBe('write');
    expectDomainError(() => f.session.setView(f.workspace, f.owner, f.owner, false), {
      code: 'CannotChangeOwnerAccess',
    });
    expect(f.session.accessOf(f.workspace, f.owner)).toBe('write');
  });

  it('strangers have no access', () => {
    const f = fixture();
    expect(f.session.accessOf(f.workspace, newUserId())).toBe('none');
  });

  it('setAccess rejects non participants', () => {
    const f = fixture();
    const stranger = newUserId();
    expectDomainError(() => f.session.setAccess(f.workspace, f.owner, stranger, 'write'), {
      code: 'NotAParticipant',
      user: stranger,
    });
  });

  it('removed member loses access', () => {
    const f = fixture();
    f.workspace.removeMember(f.owner, f.member);
    expect(f.session.canView(f.workspace, f.member)).toBe(false);
  });

  it('cannot invite existing member as guest', () => {
    const f = fixture();
    expectDomainError(() => f.session.inviteGuest(f.workspace, f.owner, f.member), {
      code: 'AlreadyHasAccess',
      user: f.member,
    });
  });

  it('cannot invite the same guest twice, nor accept a stale invitation', () => {
    const f = fixture();
    const guest = newUserId();
    const inv = f.session.inviteGuest(f.workspace, f.owner, guest);
    f.session.acceptInvitation(f.workspace, inv);
    expectDomainError(() => f.session.acceptInvitation(f.workspace, inv), {
      code: 'AlreadyHasAccess',
      user: guest,
    });
    expectDomainError(() => f.session.inviteGuest(f.workspace, f.owner, guest), {
      code: 'AlreadyHasAccess',
      user: guest,
    });
  });

  it('only owner invites guests', () => {
    const f = fixture();
    expectDomainError(() => f.session.inviteGuest(f.workspace, f.member, newUserId()), {
      code: 'NotOwner',
    });
  });

  it('rejects an invitation for another session or workspace target', () => {
    const f = fixture();
    const other = Session.create(f.workspace, f.owner, 'otra');
    const inv = other.inviteGuest(f.workspace, f.owner, newUserId());
    expectDomainError(() => f.session.acceptInvitation(f.workspace, inv), {
      code: 'InvitationTargetMismatch',
    });
    const wsInv = f.workspace.inviteMember(f.owner, newUserId());
    expectDomainError(() => f.session.acceptInvitation(f.workspace, wsInv), {
      code: 'InvitationTargetMismatch',
    });
  });

  it('wrong workspace grants no access', () => {
    const f = fixture();
    const foreign = new Workspace(f.member, 'ajeno');
    expect(f.session.accessOf(foreign, f.member)).toBe('none');
    expect(f.session.participants(foreign)).toEqual([]);
  });

  it('mutators reject a workspace that does not own the session', () => {
    const f = fixture();
    const foreign = new Workspace(f.owner, 'ajeno');
    const mismatch = {
      code: 'WorkspaceMismatch',
      session: f.session.id,
      workspace: foreign.id,
    } as const;
    expectDomainError(() => f.session.setAccess(foreign, f.owner, f.member, 'none'), mismatch);
    expectDomainError(() => f.session.inviteGuest(foreign, f.owner, newUserId()), mismatch);
    expectDomainError(
      () => f.session.addTerminal(foreign, f.owner, newAgentProfile('s', 'sh')),
      mismatch,
    );
    expectDomainError(() => Session.create(foreign, newUserId(), 'x'), { code: 'NotOwner' });
  });

  it('participants lists effective access', () => {
    const f = fixture();
    const guest = withGuest(f);
    const participants = f.session.participants(f.workspace);
    expect(participants).toHaveLength(3);
    const find = (u: UserId) => participants.find((p) => p.userId === u)!;
    expect(find(f.owner).role).toBe('owner');
    expect(find(f.member).access).toBe('view');
    expect(find(guest).role).toBe('guest');
  });
});
