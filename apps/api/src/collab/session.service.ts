import { Inject, Injectable } from '@nestjs/common';

import { Session, type SessionId, type UserId, type Workspace, type WorkspaceId } from '@opencollab/domain';

import { SessionRepository } from '../persistence/session.repository';
import { WorkspaceRepository } from '../persistence/workspace.repository';
import { toSessionView, type SessionView } from './views';

// `not-found` covers both a missing workspace and a caller with no relation to
// it: sessions endpoints must not leak workspace existence (S4/S5).
export type SessionListResult =
  | { kind: 'ok'; views: SessionView[] }
  | { kind: 'not-found' };

export type SessionCreateResult =
  | { kind: 'created'; view: SessionView }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

// S6: the session itself is either invisible (403 when it exists but the
// caller cannot view it) or missing (404).
export type SessionDetailResult =
  | { kind: 'ok'; view: SessionView }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

@Injectable()
export class SessionService {
  constructor(
    @Inject(WorkspaceRepository) private readonly workspaces: WorkspaceRepository,
    @Inject(SessionRepository) private readonly sessions: SessionRepository,
  ) {}

  // Workspace classification for the nested routes: unknown or stranger is
  // `not-found`, any member (owner or not) is `ok`.
  private async access(
    workspaceId: WorkspaceId,
    actor: UserId,
  ): Promise<{ kind: 'not-found' } | { kind: 'ok'; workspace: Workspace; owner: boolean }> {
    const ws = await this.workspaces.find(workspaceId);
    if (!ws || (!ws.isOwner(actor) && !ws.isMember(actor))) return { kind: 'not-found' };
    return { kind: 'ok', workspace: ws, owner: ws.isOwner(actor) };
  }

  async create(actor: UserId, workspaceId: WorkspaceId, name: string): Promise<SessionCreateResult> {
    const acc = await this.access(workspaceId, actor);
    if (acc.kind === 'not-found') return acc;
    if (!acc.owner) return { kind: 'forbidden' };
    // `Session.create` re-checks ownership in the domain (ensureOwner).
    const session = Session.create(acc.workspace, actor, name);
    await this.sessions.save(session);
    return { kind: 'created', view: toSessionView(session) };
  }

  async list(actor: UserId, workspaceId: WorkspaceId): Promise<SessionListResult> {
    const acc = await this.access(workspaceId, actor);
    if (acc.kind === 'not-found') return acc;
    const list = await this.sessions.listByWorkspace(workspaceId);
    return { kind: 'ok', views: list.map(toSessionView) };
  }

  async detail(id: SessionId, actor: UserId): Promise<SessionDetailResult> {
    const session = await this.sessions.find(id);
    if (!session) return { kind: 'not-found' };
    const ws = await this.workspaces.find(session.workspaceId);
    if (!ws || !session.canView(ws, actor)) return { kind: 'forbidden' };
    return { kind: 'ok', view: toSessionView(session) };
  }
}
