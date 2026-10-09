import type { Session, SessionId } from '../domain';
import type { SessionState, SessionStore } from '../hub';
import type { SessionRepository } from './session.repository';
import type { WorkspaceRepository } from './workspace.repository';

// Adapter for the hub's port: a session is always loaded with its workspace,
// because access is resolved against both.
export class RepositorySessionStore implements SessionStore {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly workspaces: WorkspaceRepository,
  ) {}

  async load(id: SessionId): Promise<SessionState | undefined> {
    const session = await this.sessions.find(id);
    if (!session) return undefined;
    const workspace = await this.workspaces.find(session.workspaceId);
    return workspace ? { session, workspace } : undefined;
  }

  save(session: Session): Promise<void> {
    return this.sessions.save(session);
  }
}
