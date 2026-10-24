import { Workspace, type UserId, type WorkspaceId } from '@opencollab/domain';
import type { PrismaClient } from '../generated/prisma/client';

// Aggregate-level port: the whole Workspace (with its members) in and out.
export class WorkspaceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async find(id: WorkspaceId): Promise<Workspace | undefined> {
    const row = await this.prisma.workspace.findUnique({
      where: { id },
      include: { members: { orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }] } },
    });
    if (!row) return undefined;
    return Workspace.restore({
      id: row.id as WorkspaceId,
      owner: row.ownerId as UserId,
      name: row.name,
      members: row.members.map((m) => m.userId as UserId),
    });
  }

  // Every workspace where the user is owner or member, oldest first.
  async listForUser(userId: UserId): Promise<Workspace[]> {
    const rows = await this.prisma.workspace.findMany({
      where: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
      include: { members: { orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }] } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) =>
      Workspace.restore({
        id: row.id as WorkspaceId,
        owner: row.ownerId as UserId,
        name: row.name,
        members: row.members.map((m) => m.userId as UserId),
      }),
    );
  }

  // Upserts the workspace and makes the member rows match the aggregate.
  // Existing members keep their joinedAt.
  async save(workspace: Workspace): Promise<void> {
    const memberIds = workspace.members.map((m) => m.userId);
    await this.prisma.$transaction([
      this.prisma.workspace.upsert({
        where: { id: workspace.id },
        create: { id: workspace.id, name: workspace.name, ownerId: workspace.owner },
        update: { name: workspace.name },
      }),
      this.prisma.workspaceMember.deleteMany({
        where: { workspaceId: workspace.id, userId: { notIn: memberIds } },
      }),
      this.prisma.workspaceMember.createMany({
        data: memberIds.map((userId) => ({ workspaceId: workspace.id, userId })),
        skipDuplicates: true,
      }),
    ]);
  }

  // Removes the aggregate row; members, sessions, terminals and invitations
  // follow the schema's onDelete cascade.
  async delete(id: WorkspaceId): Promise<void> {
    // deleteMany over delete: an id raced away between the controller's
    // existence check and here must not turn into a P2025 500.
    await this.prisma.workspace.deleteMany({ where: { id } });
  }
}
