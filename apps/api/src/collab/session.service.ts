import { Inject, Injectable } from '@nestjs/common';

import {
  newAgentProfile,
  Session,
  type SessionId,
  type Terminal,
  type TerminalId,
  type UserId,
  type Workspace,
  type WorkspaceId,
} from '@opencollab/domain';

import { SessionRepository } from '../persistence/session.repository';
import { WorkspaceRepository } from '../persistence/workspace.repository';
import { toSessionView, toTerminalView, type SessionView, type TerminalView } from './views';
import type { AddTerminalBody, ReorderTerminalsBody, UpdateTerminalBody } from './dto';

// `not-found` covers both a missing workspace and a caller with no relation to
// it: sessions endpoints must not leak workspace existence (S4/S5).
export type SessionListResult =
  | { kind: 'ok'; views: SessionView[] }
  | { kind: 'not-found' };

// S7: the explicit-id create answers the current view when the caller already
// owns that id (idempotent), and 409 when someone else owns it.
export type SessionCreateResult =
  | { kind: 'created'; view: SessionView }
  | { kind: 'existing'; view: SessionView }
  | { kind: 'conflict' }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

// S6: the session itself is either invisible (403 when it exists but the
// caller cannot view it) or missing (404).
export type SessionDetailResult =
  | { kind: 'ok'; view: SessionView }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

// S7: rename/delete are owner actions; a non-owner (member, stranger or guest)
// answers 403 without learning whether the session exists.
export type SessionRenameResult =
  | { kind: 'ok'; view: SessionView }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

export type SessionRemoveResult =
  | { kind: 'removed' }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

// S7/S8: terminal mutations are owner-only; a non-owner never learns whether
// a terminal id exists (owner check runs before terminal existence).
export type TerminalCreateResult =
  | { kind: 'created'; view: TerminalView }
  | { kind: 'existing'; view: TerminalView }
  | { kind: 'conflict' }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

export type TerminalUpdateResult =
  | { kind: 'ok'; view: TerminalView }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

export type TerminalRemoveResult =
  | { kind: 'removed' }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

// The order body is a request-shape rule (S7): exactly the session's
// terminals, no duplicates, no omissions — anything else is 400.
export type TerminalsOrderResult =
  | { kind: 'ok'; views: TerminalView[] }
  | { kind: 'bad-request' }
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

  async create(
    actor: UserId,
    workspaceId: WorkspaceId,
    input: { name: string; id?: string },
  ): Promise<SessionCreateResult> {
    const acc = await this.access(workspaceId, actor);
    if (acc.kind === 'not-found') return acc;
    if (!acc.owner) return { kind: 'forbidden' };
    if (input.id !== undefined) {
      const existing = await this.sessions.find(input.id as SessionId);
      if (existing) {
        const existingWorkspace = await this.workspaces.find(existing.workspaceId);
        // The session exists: same owner answers its current view (idempotent),
        // another owner's id answers conflict.
        if (existingWorkspace && existingWorkspace.isOwner(actor)) {
          return { kind: 'existing', view: toSessionView(existing) };
        }
        return { kind: 'conflict' };
      }
    }
    // `Session.create` re-checks ownership in the domain (ensureOwner).
    const session = Session.create(
      acc.workspace,
      actor,
      input.name,
      ...(input.id === undefined ? [] : [input.id as SessionId]),
    );
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
    if (body.id !== undefined) {
      const existing = await this.sessions.terminalWithOwner(body.id as TerminalId);
      if (existing) {
        // Same owner answers the current terminal (idempotent; the id may even
        // live in another session of the same caller); otherwise 409.
        if (existing.ownerId !== actor) return { kind: 'conflict' };
        return { kind: 'existing', view: toTerminalView(existing.terminal) };
      }
    }
    // The domain factory copies args/env and enforces a non-blank command;
    // env is always empty because the strict schema never accepts it (S7).
    const profile = newAgentProfile(body.name, body.command, {
      ...(body.args === undefined ? {} : { args: body.args }),
      ...(body.cwd == null ? {} : { cwd: body.cwd }),
    });
    // `addTerminal` re-checks ownership in the domain (ensureOwner).
    const terminalId = acc.session.addTerminal(acc.workspace, actor, profile, {
      ...(body.id === undefined ? {} : { id: body.id as TerminalId }),
      ...(body.agent === undefined ? {} : { agent: body.agent }),
      ...(body.minimized === undefined ? {} : { minimized: body.minimized }),
    });
    await this.sessions.save(acc.session);
    const terminal = acc.session.terminal(terminalId);
    if (!terminal) throw new Error('terminal vanished after addTerminal'); // unreachable
    return { kind: 'created', view: toTerminalView(terminal) };
  }

  async updateTerminal(
    actor: UserId,
    sessionId: SessionId,
    terminalId: TerminalId,
    patch: UpdateTerminalBody,
  ): Promise<TerminalUpdateResult> {
    const acc = await this.ownedSession(sessionId, actor);
    if (acc.kind !== 'ok') return acc;
    // TerminalNotInSession → 404 (the owner check already ran above).
    const terminal = acc.session.terminal(terminalId);
    if (!terminal) return { kind: 'not-found' };
    // The domain factory rebuilds the profile, so a blank command stays
    // impossible; the schema's blank check already rejected it anyway.
    acc.session.updateTerminal(acc.workspace, actor, terminalId, patch);
    await this.sessions.save(acc.session);
    const updated = acc.session.terminal(terminalId);
    if (!updated || !isTerminal(updated)) throw new Error('terminal vanished after updateTerminal'); // unreachable
    return { kind: 'ok', view: toTerminalView(updated) };
  }

  // S7: the ids must be exactly the session's terminals — no duplicates, no
  // omissions, no strangers — checked before the aggregate is touched.
  async reorderTerminals(
    actor: UserId,
    sessionId: SessionId,
    body: ReorderTerminalsBody,
  ): Promise<TerminalsOrderResult> {
    const acc = await this.ownedSession(sessionId, actor);
    if (acc.kind !== 'ok') return acc;
    const stored = acc.session.terminals;
    const requested = body.ids as TerminalId[];
    const requestedSet = new Set(requested);
    if (
      requested.length !== stored.length ||
      requestedSet.size !== requested.length ||
      !stored.every((t) => requestedSet.has(t.id))
    ) {
      return { kind: 'bad-request' };
    }
    // `reorderTerminals` re-checks ownership and membership in the domain.
    acc.session.reorderTerminals(acc.workspace, actor, requested);
    await this.sessions.save(acc.session);
    return { kind: 'ok', views: acc.session.terminals.map(toTerminalView) };
  }

  async renameSession(actor: UserId, sessionId: SessionId, name: string): Promise<SessionRenameResult> {
    const acc = await this.ownedSession(sessionId, actor);
    if (acc.kind !== 'ok') return acc;
    // Unreachable NotOwner: the classification above is the same check.
    acc.session.rename(acc.workspace, actor, name);
    await this.sessions.save(acc.session);
    return { kind: 'ok', view: toSessionView(acc.session) };
  }

  async removeSession(actor: UserId, sessionId: SessionId): Promise<SessionRemoveResult> {
    const acc = await this.ownedSession(sessionId, actor);
    if (acc.kind !== 'ok') return acc;
    await this.sessions.delete(sessionId);
    return { kind: 'removed' };
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

// The domain mutators replace the terminal object entirely, so the re-read
// requires the metadata-bearing shape; this keeps the unreachable guard typed.
function isTerminal(value: Terminal | undefined): value is Terminal {
  return value !== undefined;
}
