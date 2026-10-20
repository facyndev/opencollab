import { DomainError } from './error';
import {
  newInvitationId,
  newSessionId,
  newTerminalId,
  type SessionId,
  type TerminalId,
  type UserId,
  type WorkspaceId,
} from './ids';
import type { Invitation } from './invitation';
import {
  DEFAULT_ACCESS,
  canView,
  canWrite,
  withView,
  withWrite,
  type AccessLevel,
} from './permission';
import {
  newAgentProfile,
  newTerminal,
  type AgentProfile,
  type Terminal,
  type TerminalCreateOptions,
  type TerminalPatch,
} from './terminal';
import type { Workspace } from './workspace';

// Temporary guest: access to this session only, never the rest of the workspace.
export interface SessionGuest {
  userId: UserId;
  access: AccessLevel;
}

export type ParticipantRole = 'owner' | 'member' | 'guest';

export interface Participant {
  readonly userId: UserId;
  readonly role: ParticipantRole;
  readonly access: AccessLevel;
}

// A group of terminals shown together; the unit shared live. A member's
// effective access is their override in this session or DEFAULT_ACCESS, so a
// member added after the session was created also starts with view.
export class Session {
  private readonly _terminals: Terminal[] = [];
  private readonly memberOverrides = new Map<UserId, AccessLevel>();
  private readonly _guests: SessionGuest[] = [];

  private constructor(
    readonly id: SessionId,
    readonly workspaceId: WorkspaceId,
    private _name: string,
  ) {}

  static create(workspace: Workspace, actor: UserId, name: string, id?: SessionId): Session {
    workspace.ensureOwner(actor);
    // An explicit id (S7) lets a client retry its create without duplicating
    // the aggregate; the caller still runs the ownership/idempotency checks.
    return new Session(id ?? newSessionId(), workspace.id, name);
  }

  // Rebuilds an aggregate from persisted state: no creation-time checks.
  // Only explicit overrides are restored; members without one stay at the default.
  static restore(state: {
    id: SessionId;
    workspaceId: WorkspaceId;
    name: string;
    terminals: readonly Terminal[];
    overrides: readonly (readonly [UserId, AccessLevel])[];
    guests: readonly SessionGuest[];
  }): Session {
    const session = new Session(state.id, state.workspaceId, state.name);
    session._terminals.push(...state.terminals);
    for (const [user, level] of state.overrides) session.memberOverrides.set(user, level);
    session._guests.push(...state.guests.map((g) => ({ ...g })));
    return session;
  }

  // Explicit overrides, for persistence. Effective access is never derived from this.
  get overrides(): [UserId, AccessLevel][] {
    return [...this.memberOverrides];
  }

  get name(): string {
    return this._name;
  }

  get terminals(): readonly Terminal[] {
    return this._terminals;
  }

  get guests(): readonly SessionGuest[] {
    return this._guests;
  }

  terminal(id: TerminalId): Terminal | undefined {
    return this._terminals.find((t) => t.id === id);
  }

  private ensureBelongsTo(workspace: Workspace): void {
    if (workspace.id !== this.workspaceId) {
      throw new DomainError({
        code: 'WorkspaceMismatch',
        session: this.id,
        workspace: workspace.id,
      });
    }
  }

  private guest(user: UserId): SessionGuest | undefined {
    return this._guests.find((g) => g.userId === user);
  }

  private roleOf(workspace: Workspace, user: UserId): ParticipantRole | undefined {
    if (workspace.isOwner(user)) return 'owner';
    if (workspace.isMember(user)) return 'member';
    if (this.guest(user)) return 'guest';
    return undefined;
  }

  // Single source of truth for a user's access. A foreign workspace yields 'none'.
  accessOf(workspace: Workspace, user: UserId): AccessLevel {
    if (workspace.id !== this.workspaceId) return 'none';
    switch (this.roleOf(workspace, user)) {
      case 'owner':
        return 'write';
      case 'member':
        return this.memberOverrides.get(user) ?? DEFAULT_ACCESS;
      case 'guest':
        return this.guest(user)?.access ?? 'none';
      default:
        return 'none';
    }
  }

  canView(workspace: Workspace, user: UserId): boolean {
    return canView(this.accessOf(workspace, user));
  }

  canWrite(workspace: Workspace, user: UserId): boolean {
    return canWrite(this.accessOf(workspace, user));
  }

  // Owner, members and guests with their effective access.
  participants(workspace: Workspace): Participant[] {
    if (workspace.id !== this.workspaceId) return [];
    const ids = [
      workspace.owner,
      ...workspace.members.map((m) => m.userId),
      ...this._guests.map((g) => g.userId),
    ];
    const out: Participant[] = [];
    for (const userId of ids) {
      const role = this.roleOf(workspace, userId);
      if (role) out.push({ userId, role, access: this.accessOf(workspace, userId) });
    }
    return out;
  }

  // Owner-only, any time while the session is live. Returns the resulting level.
  setAccess(workspace: Workspace, actor: UserId, target: UserId, level: AccessLevel): AccessLevel {
    this.ensureBelongsTo(workspace);
    workspace.ensureOwner(actor);
    switch (this.roleOf(workspace, target)) {
      case 'owner':
        throw new DomainError({ code: 'CannotChangeOwnerAccess' });
      case 'member':
        this.memberOverrides.set(target, level);
        return level;
      case 'guest': {
        const guest = this.guest(target);
        if (!guest) throw new DomainError({ code: 'NotAParticipant', user: target });
        guest.access = level;
        return level;
      }
      default:
        throw new DomainError({ code: 'NotAParticipant', user: target });
    }
  }

  // Disabling view also revokes write and access.
  setView(workspace: Workspace, actor: UserId, target: UserId, enabled: boolean): AccessLevel {
    return this.setAccess(workspace, actor, target, withView(this.accessOf(workspace, target), enabled));
  }

  // Enabling write also enables view.
  setWrite(workspace: Workspace, actor: UserId, target: UserId, enabled: boolean): AccessLevel {
    return this.setAccess(workspace, actor, target, withWrite(this.accessOf(workspace, target), enabled));
  }

  inviteGuest(workspace: Workspace, actor: UserId, invitee: UserId): Invitation {
    this.ensureBelongsTo(workspace);
    workspace.ensureOwner(actor);
    if (this.roleOf(workspace, invitee)) {
      throw new DomainError({ code: 'AlreadyHasAccess', user: invitee });
    }
    return {
      id: newInvitationId(),
      target: { kind: 'session', sessionId: this.id },
      invitee,
      invitedBy: actor,
    };
  }

  // The guest joins with view, the minimum for the session to be shared.
  acceptInvitation(workspace: Workspace, invitation: Invitation): void {
    this.ensureBelongsTo(workspace);
    const { target } = invitation;
    if (target.kind !== 'session' || target.sessionId !== this.id) {
      throw new DomainError({ code: 'InvitationTargetMismatch' });
    }
    workspace.ensureOwner(invitation.invitedBy);
    if (this.roleOf(workspace, invitation.invitee)) {
      throw new DomainError({ code: 'AlreadyHasAccess', user: invitation.invitee });
    }
    this._guests.push({ userId: invitation.invitee, access: DEFAULT_ACCESS });
  }

  addTerminal(
    workspace: Workspace,
    actor: UserId,
    profile: AgentProfile,
    opts: TerminalCreateOptions = {},
  ): TerminalId {
    this.ensureBelongsTo(workspace);
    workspace.ensureOwner(actor);
    const terminal = newTerminal(opts.id ?? newTerminalId(), profile, opts);
    this._terminals.push(terminal);
    return terminal.id;
  }

  // Owner-only partial update (S7): absent patch keys keep the current value,
  // explicit nulls clear `cwd`/`agent`. The profile is rebuilt through the
  // factory so a blank command stays impossible.
  updateTerminal(workspace: Workspace, actor: UserId, id: TerminalId, patch: TerminalPatch): void {
    this.ensureBelongsTo(workspace);
    workspace.ensureOwner(actor);
    const terminal = this.terminal(id);
    if (!terminal) throw new DomainError({ code: 'TerminalNotInSession', terminal: id });
    const p = terminal.profile;
    const cwd = patch.cwd === undefined ? (p.cwd ?? null) : patch.cwd;
    this._terminals[this._terminals.indexOf(terminal)] = newTerminal(
      id,
      newAgentProfile(patch.name ?? p.name, patch.command ?? p.command, {
        args: patch.args ?? p.args,
        ...(cwd === null ? {} : { cwd }),
      }),
      {
        agent: patch.agent === undefined ? (terminal.agent ?? null) : patch.agent,
        minimized: patch.minimized === undefined ? (terminal.minimized ?? false) : patch.minimized,
      },
    );
  }

  // Owner-only reorder (S7): `ids` is the exact new order. The caller must pass
  // the session's terminals exactly (the REST layer turns a mismatch into 400);
  // the domain still refuses to reorder around unknown or duplicated ids.
  reorderTerminals(workspace: Workspace, actor: UserId, ids: readonly TerminalId[]): void {
    this.ensureBelongsTo(workspace);
    workspace.ensureOwner(actor);
    for (const id of ids) this.ensureHasTerminal(id);
    if (new Set(ids).size !== ids.length || ids.length !== this._terminals.length) {
      throw new Error('reorderTerminals requires exactly the session terminals, without duplicates');
    }
    const byId = new Map(this._terminals.map((t) => [t.id, t] as const));
    this._terminals.length = 0;
    for (const id of ids) this._terminals.push(byId.get(id)!);
  }

  // Like adding them, removing terminals is owner-only.
  removeTerminal(workspace: Workspace, actor: UserId, id: TerminalId): void {
    this.ensureBelongsTo(workspace);
    workspace.ensureOwner(actor);
    this.ensureHasTerminal(id);
    const index = this._terminals.findIndex((t) => t.id === id);
    this._terminals.splice(index, 1);
  }

  // Owner-only rename (S7); persistence re-saves the aggregate afterwards.
  rename(workspace: Workspace, actor: UserId, name: string): void {
    this.ensureBelongsTo(workspace);
    workspace.ensureOwner(actor);
    this._name = name;
  }

  ensureHasTerminal(id: TerminalId): void {
    if (!this.terminal(id)) throw new DomainError({ code: 'TerminalNotInSession', terminal: id });
  }
}
