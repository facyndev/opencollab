import type { InvitationId, SessionId, UserId, WorkspaceId } from './ids';

// What an invitation grants: permanent workspace membership or a temporary
// guest spot in a single session. Two distinct concepts.
export type InvitationTarget =
  | { readonly kind: 'workspace'; readonly workspaceId: WorkspaceId }
  | { readonly kind: 'session'; readonly sessionId: SessionId };

// Created by `Workspace.inviteMember` / `Session.inviteGuest`, which check
// that the inviter is the owner.
export interface Invitation {
  readonly id: InvitationId;
  readonly target: InvitationTarget;
  readonly invitee: UserId;
  readonly invitedBy: UserId;
}
