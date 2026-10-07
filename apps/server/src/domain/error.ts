import type { SessionId, TerminalId, UserId, WorkspaceId } from './ids';

// Mirrors the variants of `DomainError` in `crates/domain/src/error.rs`.
export type DomainErrorInfo =
  | { code: 'NotOwner' }
  | { code: 'CannotChangeOwnerAccess' }
  | { code: 'NotAParticipant'; user: UserId }
  | { code: 'AlreadyHasAccess'; user: UserId }
  | { code: 'WorkspaceMismatch'; session: SessionId; workspace: WorkspaceId }
  | { code: 'InvitationTargetMismatch' }
  | { code: 'TerminalNotInSession'; terminal: TerminalId }
  | { code: 'EmptyCommand' };

export type DomainErrorCode = DomainErrorInfo['code'];

function describe(info: DomainErrorInfo): string {
  switch (info.code) {
    case 'NotOwner':
      return 'only the workspace owner can perform this action';
    case 'CannotChangeOwnerAccess':
      return "the owner's access cannot be modified";
    case 'NotAParticipant':
      return `${info.user} does not participate in the session`;
    case 'AlreadyHasAccess':
      return `${info.user} already has access`;
    case 'WorkspaceMismatch':
      return `session ${info.session} does not belong to workspace ${info.workspace}`;
    case 'InvitationTargetMismatch':
      return 'the invitation does not match this target';
    case 'TerminalNotInSession':
      return `terminal ${info.terminal} does not belong to the session`;
    case 'EmptyCommand':
      return 'the agent profile command cannot be empty';
  }
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(readonly info: DomainErrorInfo) {
    super(describe(info));
    this.name = 'DomainError';
    this.code = info.code;
  }
}

export class InvalidIdError extends Error {
  constructor(readonly value: string) {
    super(`invalid identifier: ${JSON.stringify(value)}`);
    this.name = 'InvalidIdError';
  }
}
