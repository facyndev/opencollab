import { Inject, Injectable } from '@nestjs/common';

import { Workspace, type UserId, type WorkspaceId } from '@opencollab/domain';

import { UserRepository } from '../persistence/user.repository';
import { WorkspaceRepository } from '../persistence/workspace.repository';
import { toWorkspaceDetail, toWorkspaceSummary, type WorkspaceDetail, type WorkspaceSummary } from './views';

export type WorkspaceLookup =
  | { kind: 'ok'; workspace: Workspace }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

// S7: the explicit-id create answers the current view when the caller already
// owns that id (idempotent), and 409 when someone else owns it.
export type WorkspaceCreateResult =
  | { kind: 'created'; view: WorkspaceDetail }
  | { kind: 'existing'; view: WorkspaceDetail }
  | { kind: 'conflict' };

// Rename/remove are owner actions: a member who can read still answers 403,
// with the same not-found/forbidden classification as GET detail.
export type WorkspaceRenameResult =
  | { kind: 'ok'; view: WorkspaceDetail }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

export type WorkspaceRemoveResult =
  | { kind: 'removed' }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

@Injectable()
export class WorkspaceService {
  constructor(
    @Inject(WorkspaceRepository) private readonly workspaces: WorkspaceRepository,
    @Inject(UserRepository) private readonly users: UserRepository,
  ) {}

  async create(actor: UserId, input: { name: string; id?: string }): Promise<WorkspaceCreateResult> {
    if (input.id !== undefined) {
      const existing = await this.workspaces.find(input.id as WorkspaceId);
      if (existing) {
        if (!existing.isOwner(actor)) return { kind: 'conflict' };
        return { kind: 'existing', view: await this.detail(existing) };
      }
    }
    const ws = new Workspace(actor, input.name, ...(input.id === undefined ? [] : [input.id as WorkspaceId]));
    await this.workspaces.save(ws);
    return { kind: 'created', view: await this.detail(ws) };
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

  // Mutations are owner actions: members who can read still answer 403.
  private async owned(id: WorkspaceId, actor: UserId): Promise<WorkspaceLookup> {
    const ws = await this.workspaces.find(id);
    if (!ws) return { kind: 'not-found' };
    if (!ws.isOwner(actor)) return { kind: 'forbidden' };
    return { kind: 'ok', workspace: ws };
  }

  async rename(actor: UserId, id: WorkspaceId, name: string): Promise<WorkspaceRenameResult> {
    const owned = await this.owned(id, actor);
    if (owned.kind !== 'ok') return owned;
    // Unreachable NotOwner: the classification above is the same check.
    owned.workspace.rename(actor, name);
    await this.workspaces.save(owned.workspace);
    return { kind: 'ok', view: await this.detail(owned.workspace) };
  }

  async remove(actor: UserId, id: WorkspaceId): Promise<WorkspaceRemoveResult> {
    const owned = await this.owned(id, actor);
    if (owned.kind !== 'ok') return owned;
    await this.workspaces.delete(id);
    return { kind: 'removed' };
  }

  async detail(ws: Workspace): Promise<WorkspaceDetail> {
    const ids = [ws.owner, ...ws.members.map((m) => m.userId)];
    const users = await this.users.findByIds(ids);
    return toWorkspaceDetail(ws, new Map(users.map((u) => [u.id, u])));
  }
}
