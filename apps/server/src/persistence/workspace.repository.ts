import { Workspace, type UserId, type WorkspaceId } from '../domain';
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
}
