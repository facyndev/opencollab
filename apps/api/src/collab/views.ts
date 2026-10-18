import type { UserRecord } from '../persistence/user.repository';
import type { Session, SessionId, Terminal, TerminalId, UserId, Workspace, WorkspaceId } from '@opencollab/domain';

export interface WorkspaceSummary {
  id: WorkspaceId;
  name: string;
  owner: UserId;
  memberCount: number;
}

export interface MemberView {
  userId: UserId;
  username: string;
  displayName: string;
}

export interface WorkspaceDetail {
  id: WorkspaceId;
  name: string;
  owner: UserId;
  members: MemberView[];
}

export function toWorkspaceSummary(ws: Workspace): WorkspaceSummary {
  return { id: ws.id, name: ws.name, owner: ws.owner, memberCount: ws.members.length };
}

export interface TerminalView {
  id: TerminalId;
  name: string;
  command: string;
  args: string[];
  cwd: string | null;
}

export interface SessionView {
  id: SessionId;
  name: string;
  terminals: TerminalView[];
}

// `cwd` is nullable: a terminal without an explicit working directory
// persists as null. `env` is never part of the projection (S7).
export function toTerminalView(terminal: Terminal): TerminalView {
  return {
    id: terminal.id,
    name: terminal.profile.name,
    command: terminal.profile.command,
    args: terminal.profile.args,
    cwd: terminal.profile.cwd ?? null,
  };
}

// Terminals stay in the aggregate's position order (S5).
export function toSessionView(session: Session): SessionView {
  return {
    id: session.id,
    name: session.name,
    terminals: session.terminals.map(toTerminalView),
  };
}

// `usersById` supplies the display fields for the member ids; ids missing from
// the map (deleted users) are dropped from the view.
export function toWorkspaceDetail(ws: Workspace, usersById: Map<UserId, UserRecord>): WorkspaceDetail {
  const members: MemberView[] = [];
  for (const m of ws.members) {
    const user = usersById.get(m.userId);
    if (user) {
      members.push({ userId: user.id, username: user.username, displayName: user.displayName });
    }
  }
  return { id: ws.id, name: ws.name, owner: ws.owner, members };
}

export type InvitationTargetView =
  | { kind: 'workspace'; workspaceId: WorkspaceId; name: string }
  | { kind: 'session'; sessionId: SessionId; name: string };

// S9-S11: what an invitation looks like over the wire. Lifecycle fields
// (status, expiresAt) are deliberately absent: they are server bookkeeping,
// and S12/S13 signal them through status codes instead.
export interface InvitationView {
  id: string;
  target: InvitationTargetView;
  invitedBy: { userId: UserId; username: string; displayName: string };
}
