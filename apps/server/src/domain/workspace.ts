import { DomainError } from './error';
import { newInvitationId, newWorkspaceId, type UserId, type WorkspaceId } from './ids';
import type { Invitation } from './invitation';

// Permanent workspace member: sees every session with view by default.
export interface WorkspaceMember {
  readonly userId: UserId;
}

export class Workspace {
  readonly id: WorkspaceId = newWorkspaceId();
  private readonly _members: WorkspaceMember[] = [];

  constructor(
    readonly owner: UserId,
    readonly name: string,
  ) {}

  get members(): readonly WorkspaceMember[] {
    return this._members;
  }

  isOwner(user: UserId): boolean {
    return this.owner === user;
  }

  isMember(user: UserId): boolean {
    return this._members.some((m) => m.userId === user);
  }

  ensureOwner(actor: UserId): void {
    if (!this.isOwner(actor)) throw new DomainError({ code: 'NotOwner' });
  }

  inviteMember(actor: UserId, invitee: UserId): Invitation {
    this.ensureOwner(actor);
    if (this.isOwner(invitee) || this.isMember(invitee)) {
      throw new DomainError({ code: 'AlreadyHasAccess', user: invitee });
    }
    return {
      id: newInvitationId(),
      target: { kind: 'workspace', workspaceId: this.id },
      invitee,
      invitedBy: actor,
    };
  }

  acceptInvitation(invitation: Invitation): void {
    const { target } = invitation;
    if (target.kind !== 'workspace' || target.workspaceId !== this.id) {
      throw new DomainError({ code: 'InvitationTargetMismatch' });
    }
    this.addMember(invitation.invitedBy, invitation.invitee);
  }

  addMember(actor: UserId, user: UserId): void {
    this.ensureOwner(actor);
    if (this.isOwner(user) || this.isMember(user)) {
      throw new DomainError({ code: 'AlreadyHasAccess', user });
    }
    this._members.push({ userId: user });
  }

  removeMember(actor: UserId, user: UserId): void {
    this.ensureOwner(actor);
    const index = this._members.findIndex((m) => m.userId === user);
    if (index < 0) throw new DomainError({ code: 'NotAParticipant', user });
    this._members.splice(index, 1);
  }
}
