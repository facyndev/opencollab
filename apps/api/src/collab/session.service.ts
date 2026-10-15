import { Inject, Injectable } from '@nestjs/common';

import {
  newAgentProfile,
  Session,
  type SessionId,
  type TerminalId,
  type UserId,
  type Workspace,
  type WorkspaceId,
} from '@opencollab/domain';

import { SessionRepository } from '../persistence/session.repository';
import { WorkspaceRepository } from '../persistence/workspace.repository';
import { toSessionView, toTerminalView, type SessionView, type TerminalView } from './views';
import type { AddTerminalBody } from './dto';

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

// S7/S8: terminal mutations are owner-only; a non-owner never learns whether
// a terminal id exists (owner check runs before terminal existence).
export type TerminalCreateResult =
  | { kind: 'created'; view: TerminalView }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

export type TerminalRemoveResult =
  | { kind: 'removed' }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

// The loaded session + its workspace, with the owner check already applied.
type OwnedSession =
  | { kind: 'ok'; session: Session; workspace: Workspace }
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

  // Unknown session → 404; a caller without the workspace is `forbidden` (403),
  // never leaking terminal existence. A vanished workspace is `not-found`:
  // terminal mutations are meaningless without it (unreachable via cascade).
  private async ownedSession(sessionId: SessionId, actor: UserId): Promise<OwnedSession> {
    const session = await this.sessions.find(sessionId);
    if (!session) return { kind: 'not-found' };
    const workspace = await this.workspaces.find(session.workspaceId);
    if (!workspace) return { kind: 'not-found' };
    if (!workspace.isOwner(actor)) return { kind: 'forbidden' };
    return { kind: 'ok', session, workspace };
  }

  async addTerminal(actor: UserId, sessionId: SessionId, body: AddTerminalBody): Promise<TerminalCreateResult> {
    const acc = await this.ownedSession(sessionId, actor);
    if (acc.kind !== 'ok') return acc;
    // The domain factory copies args/env and enforces a non-blank command;
    // env is always empty because the strict schema never accepts it (S7).
    const profile = newAgentProfile(body.name, body.command, {
      ...(body.args === undefined ? {} : { args: body.args }),
      ...(body.cwd == null ? {} : { cwd: body.cwd }),
    });
    // `addTerminal` re-checks ownership in the domain (ensureOwner).
    const terminalId = acc.session.addTerminal(acc.workspace, actor, profile);
    await this.sessions.save(acc.session);
    const terminal = acc.session.terminal(terminalId);
    if (!terminal) throw new Error('terminal vanished after addTerminal'); // unreachable
    return { kind: 'created', view: toTerminalView(terminal) };
  }

  async removeTerminal(
    actor: UserId,
    sessionId: SessionId,
    terminalId: TerminalId,
  ): Promise<TerminalRemoveResult> {
    const acc = await this.ownedSession(sessionId, actor);
    if (acc.kind !== 'ok') return acc;
    // TerminalNotInSession → 404 (the owner check already ran above).
    if (!acc.session.terminal(terminalId)) return { kind: 'not-found' };
    acc.session.removeTerminal(acc.workspace, actor, terminalId);
    await this.sessions.save(acc.session);
    return { kind: 'removed' };
  }
}
