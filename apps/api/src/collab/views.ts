import type { UserRecord } from '../persistence/user.repository';
import type { UserId, Workspace, WorkspaceId } from '@opencollab/domain';

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
