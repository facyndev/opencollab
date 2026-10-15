import { Inject, Injectable } from '@nestjs/common';

import type {
  Invitation,
  InvitationId,
  SessionId,
  UserId,
  WorkspaceId,
} from '@opencollab/domain';
import { InvitationRepository, type StoredInvitation } from '../persistence/invitation.repository';
import { SessionRepository } from '../persistence/session.repository';
import { UserRepository } from '../persistence/user.repository';
import { WorkspaceRepository } from '../persistence/workspace.repository';
import { domainViolation } from './domain-errors';
import { isUuid } from './dto';
import type { InvitationView } from './views';

export type InvitationCreateResult =
  | { kind: 'created'; view: InvitationView }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'conflict' };

export type InvitationRespondResult =
  | { kind: 'ok' }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'conflict' };

type ResponseLookup =
  | { kind: 'ok'; stored: StoredInvitation }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'conflict' };

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(WorkspaceRepository) private readonly workspaces: WorkspaceRepository,
    @Inject(SessionRepository) private readonly sessions: SessionRepository,
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(InvitationRepository) private readonly invitations: InvitationRepository,
  ) {}

  // S9: unknown workspace 404; any non-owner (member or stranger) 403 — the
  // workspace existence is intentionally visible here, unlike the nested
  // session routes. A ghost invitee (unknown user id) is stored as-is.
  async inviteToWorkspace(
    actor: UserId,
    workspaceId: WorkspaceId,
    inviteeId: UserId,
  ): Promise<InvitationCreateResult> {
    const ws = await this.workspaces.find(workspaceId);
    if (!ws) return { kind: 'not-found' };
    if (!ws.isOwner(actor)) return { kind: 'forbidden' };
    // Unknown users cannot be invited: the invitation row holds a required FK
    // to User, so the check runs up front (after the owner check, so strangers
    // still get 403 without learning whether the user id exists).
    if (!(await this.users.findById(inviteeId))) return { kind: 'not-found' };
    let invitation: Invitation;
    try {
      invitation = ws.inviteMember(actor, inviteeId);
    } catch (error) {
      // Only AlreadyHasAccess is reachable (ownership was pre-checked).
      return { kind: this.inviteViolation(error) };
    }
    // Created invitations never expire.
    await this.invitations.save(invitation, null);
    const inviter = await this.users.findById(actor);
    if (!inviter) throw new Error('authenticated user vanished'); // unreachable
    return {
      kind: 'created',
      view: {
        id: invitation.id,
        target: { kind: 'workspace', workspaceId: ws.id, name: ws.name },
        invitedBy: { userId: inviter.id, username: inviter.username, displayName: inviter.displayName },
      },
    };
  }

  // S10: unknown session (or a session whose workspace is gone) 404; any
  // non-owner — member, stranger, or guest — 403.
  async inviteToSession(
    actor: UserId,
    sessionId: SessionId,
    inviteeId: UserId,
  ): Promise<InvitationCreateResult> {
    const session = await this.sessions.find(sessionId);
    if (!session) return { kind: 'not-found' };
    const ws = await this.workspaces.find(session.workspaceId);
    if (!ws) return { kind: 'not-found' };
    if (!ws.isOwner(actor)) return { kind: 'forbidden' };
    // Unknown users cannot be invited: the invitation row holds a required FK
    // to User, so the check runs up front (after the owner check, so strangers
    // still get 403 without learning whether the user id exists).
    if (!(await this.users.findById(inviteeId))) return { kind: 'not-found' };
    let invitation: Invitation;
    try {
      invitation = session.inviteGuest(ws, actor, inviteeId);
    } catch (error) {
      // Only AlreadyHasAccess is reachable (ownership was pre-checked).
      return { kind: this.inviteViolation(error) };
    }
    // Created invitations never expire.
    await this.invitations.save(invitation, null);
    const inviter = await this.users.findById(actor);
    if (!inviter) throw new Error('authenticated user vanished'); // unreachable
    return {
      kind: 'created',
      view: {
        id: invitation.id,
        target: { kind: 'session', sessionId: session.id, name: session.name },
        invitedBy: { userId: inviter.id, username: inviter.username, displayName: inviter.displayName },
      },
    };
  }

  // S11: the caller's pending, non-expired invitations, oldest first.
  async list(actor: UserId): Promise<InvitationView[]> {
    const pending = await this.invitations.listPendingFor(actor);
    const inviterIds = [...new Set(pending.map((s) => s.invitation.invitedBy))];
    const inviters = new Map((await this.users.findByIds(inviterIds)).map((u) => [u.id, u] as const));
    const views: InvitationView[] = [];
    for (const stored of pending) {
      const inviter = inviters.get(stored.invitation.invitedBy);
      if (!inviter) continue; // inviter deleted: nothing to attribute the entry to
      const { target } = stored.invitation;
      if (target.kind === 'workspace') {
        // A target that no longer loads is skipped, never listed as an orphan:
        // the entry would name something the caller can no longer accept.
        const ws = await this.workspaces.find(target.workspaceId);
        if (!ws) continue;
        views.push({
          id: stored.invitation.id,
          target: { kind: 'workspace', workspaceId: ws.id, name: ws.name },
          invitedBy: { userId: inviter.id, username: inviter.username, displayName: inviter.displayName },
        });
      } else {
        const session = await this.sessions.find(target.sessionId);
        if (!session) continue;
        views.push({
          id: stored.invitation.id,
          target: { kind: 'session', sessionId: session.id, name: session.name },
          invitedBy: { userId: inviter.id, username: inviter.username, displayName: inviter.displayName },
        });
      }
    }
    return views;
  }

  // S12: applies the domain accept, persists the aggregate, then marks the
  // invitation accepted — in that order, so a failed accept never leaves a
  // half-applied aggregate plus an accepted invitation (S15).
  async accept(actor: UserId, id: string): Promise<InvitationRespondResult> {
    const loaded = await this.loadForResponse(id, actor);
    if (loaded.kind !== 'ok') return loaded;
    const { invitation } = loaded.stored;
    if (invitation.target.kind === 'workspace') {
      const ws = await this.workspaces.find(invitation.target.workspaceId);
      if (!ws) return { kind: 'not-found' };
      try {
        ws.acceptInvitation(invitation);
      } catch (error) {
        // The aggregate is untouched and the invitation stays pending.
        return { kind: this.respondViolation(error) };
      }
      // The aggregate save is already one batch transaction; only once it is
      // fully applied may the invitation be marked accepted — never the
      // reverse, so a crash between the two cannot accept without applying.
      await this.workspaces.save(ws);
      try {
        await this.invitations.setStatus(invitation.id, 'accepted');
      } catch {
        // Count 0 after our pending check means a raced response slipped in.
        return { kind: 'conflict' };
      }
      return { kind: 'ok' };
    }
    const session = await this.sessions.find(invitation.target.sessionId);
    if (!session) return { kind: 'not-found' };
    const ws = await this.workspaces.find(session.workspaceId);
    if (!ws) return { kind: 'not-found' };
    try {
      session.acceptInvitation(ws, invitation);
    } catch (error) {
      // The aggregate is untouched and the invitation stays pending.
      return { kind: this.respondViolation(error) };
    }
    await this.sessions.save(session);
    try {
      await this.invitations.setStatus(invitation.id, 'accepted');
    } catch {
      // Count 0 after our pending check means a raced response slipped in.
      return { kind: 'conflict' };
    }
    return { kind: 'ok' };
  }

  // S13: declining only flips the invitation row; it never touches aggregates.
  async decline(actor: UserId, id: string): Promise<InvitationRespondResult> {
    const loaded = await this.loadForResponse(id, actor);
    if (loaded.kind !== 'ok') return loaded;
    try {
      await this.invitations.setStatus(loaded.stored.invitation.id, 'declined');
    } catch {
      // Count 0 after our pending check means a raced response slipped in.
      return { kind: 'conflict' };
    }
    return { kind: 'ok' };
  }

  // Shared S12/S13 gate, strictly ordered: (1) unknown or malformed id 404 —
  // malformed is pre-checked because Postgres uuid columns throw on it;
  // (2) caller is not the invitee 403, before any status signal (no leak);
  // (3) expired or no longer pending 409.
  private async loadForResponse(id: string, actor: UserId): Promise<ResponseLookup> {
    if (!isUuid(id)) return { kind: 'not-found' };
    const stored = await this.invitations.find(id as InvitationId);
    if (!stored) return { kind: 'not-found' };
    if (stored.invitation.invitee !== actor) return { kind: 'forbidden' };
    if (stored.status !== 'pending' || (stored.expiresAt !== null && stored.expiresAt <= new Date())) {
      return { kind: 'conflict' };
    }
    return { kind: 'ok', stored };
  }

  // Invites only ever raise AlreadyHasAccess past the ownership pre-check;
  // anything else is an invariant break and must surface, not map.
  private inviteViolation(error: unknown): 'forbidden' | 'conflict' {
    const violation = domainViolation(error);
    if (violation === 'forbidden' || violation === 'conflict') return violation;
    throw error;
  }

  // Accepts only ever raise AlreadyHasAccess (invitee already has the role),
  // InvitationTargetMismatch, or NotOwner (inviter lost ownership); anything
  // else is an invariant break and must surface, not map.
  private respondViolation(error: unknown): 'forbidden' | 'conflict' {
    const violation = domainViolation(error);
    if (violation === 'forbidden' || violation === 'conflict') return violation;
    throw error;
  }
}
