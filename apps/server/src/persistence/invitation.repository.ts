import type {
  Invitation,
  InvitationId,
  InvitationTarget,
  SessionId,
  UserId,
  WorkspaceId,
} from '../domain';
import type { PrismaClient } from '../generated/prisma/client';
import type { InvitationKind, InvitationStatus as DbStatus } from '../generated/prisma/enums';

export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';

// An invitation as stored: the domain value plus its lifecycle.
export interface StoredInvitation {
  readonly invitation: Invitation;
  readonly status: InvitationStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly respondedAt: Date | null;
}

const STATUS_TO_DB: Record<InvitationStatus, DbStatus> = {
  pending: 'PENDING',
  accepted: 'ACCEPTED',
  declined: 'DECLINED',
  revoked: 'REVOKED',
  expired: 'EXPIRED',
};
const STATUS_FROM_DB: Record<DbStatus, InvitationStatus> = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
};

interface Row {
  id: string;
  kind: InvitationKind;
  workspaceId: string | null;
  sessionId: string | null;
  inviteeId: string;
  invitedById: string;
  status: DbStatus;
  createdAt: Date;
  expiresAt: Date | null;
  respondedAt: Date | null;
}

function toStored(row: Row): StoredInvitation {
  const target: InvitationTarget =
    row.kind === 'WORKSPACE'
      ? { kind: 'workspace', workspaceId: row.workspaceId as WorkspaceId }
      : { kind: 'session', sessionId: row.sessionId as SessionId };
  return {
    invitation: {
      id: row.id as InvitationId,
      target,
      invitee: row.inviteeId as UserId,
      invitedBy: row.invitedById as UserId,
    },
    status: STATUS_FROM_DB[row.status],
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    respondedAt: row.respondedAt,
  };
}

export class InvitationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // Stores a new invitation as pending; saving an existing id changes nothing.
  async save(invitation: Invitation, expiresAt: Date | null = null): Promise<void> {
    const { target } = invitation;
    await this.prisma.invitation.upsert({
      where: { id: invitation.id },
      update: {},
      create: {
        id: invitation.id,
        kind: target.kind === 'workspace' ? 'WORKSPACE' : 'SESSION',
        workspaceId: target.kind === 'workspace' ? target.workspaceId : null,
        sessionId: target.kind === 'session' ? target.sessionId : null,
        inviteeId: invitation.invitee,
        invitedById: invitation.invitedBy,
        expiresAt,
      },
    });
  }

  async find(id: InvitationId): Promise<StoredInvitation | undefined> {
    const row = await this.prisma.invitation.findUnique({ where: { id } });
    return row ? toStored(row) : undefined;
  }

  // Expired invitations (past `expiresAt`) are not pending, whatever their stored status.
  async listPendingFor(userId: UserId, now: Date = new Date()): Promise<StoredInvitation[]> {
    const rows = await this.prisma.invitation.findMany({
      where: {
        inviteeId: userId,
        status: 'PENDING',
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toStored);
  }

  // Responses are final: only a pending invitation can change status.
  async setStatus(id: InvitationId, status: Exclude<InvitationStatus, 'pending'>): Promise<void> {
    if ((status as InvitationStatus) === 'pending') throw new Error('cannot set status to pending');
    const { count } = await this.prisma.invitation.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: STATUS_TO_DB[status], respondedAt: new Date() },
    });
    if (count === 0) throw new Error(`invitation ${id} not found or not pending`);
  }
}
