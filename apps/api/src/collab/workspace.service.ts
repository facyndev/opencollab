import { Inject, Injectable } from '@nestjs/common';

import { Workspace, type UserId, type WorkspaceId } from '@opencollab/domain';

import { UserRepository } from '../persistence/user.repository';
import { WorkspaceRepository } from '../persistence/workspace.repository';
import { toWorkspaceDetail, toWorkspaceSummary, type WorkspaceDetail, type WorkspaceSummary } from './views';

export type WorkspaceLookup =
  | { kind: 'ok'; workspace: Workspace }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

@Injectable()
export class WorkspaceService {
  constructor(
    @Inject(WorkspaceRepository) private readonly workspaces: WorkspaceRepository,
    @Inject(UserRepository) private readonly users: UserRepository,
  ) {}

  async create(actor: UserId, name: string): Promise<WorkspaceDetail> {
    const ws = new Workspace(actor, name);
    await this.workspaces.save(ws);
    return this.detail(ws);
  }

  async listFor(actor: UserId): Promise<WorkspaceSummary[]> {
    const list = await this.workspaces.listForUser(actor);
    return list.map(toWorkspaceSummary);
  }

  // Loads a workspace and classifies the caller's access so the controller can
  // answer 404 vs 403 without leaking existence to strangers.
  async lookup(id: WorkspaceId, actor: UserId): Promise<WorkspaceLookup> {
    const ws = await this.workspaces.find(id);
    if (!ws) return { kind: 'not-found' };
    if (!ws.isOwner(actor) && !ws.isMember(actor)) return { kind: 'forbidden' };
    return { kind: 'ok', workspace: ws };
  }

  async detail(ws: Workspace): Promise<WorkspaceDetail> {
    const ids = [ws.owner, ...ws.members.map((m) => m.userId)];
    const users = await this.users.findByIds(ids);
    return toWorkspaceDetail(ws, new Map(users.map((u) => [u.id, u])));
  }
}
