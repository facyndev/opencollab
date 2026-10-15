import { DomainError } from '@opencollab/domain';

// S15: maps a caught domain error to the HTTP-equivalent result kind. The
// controller turns each kind into its Nest exception; anything that is not a
// DomainError is rethrown unchanged and becomes a 500.
export type DomainViolation = 'forbidden' | 'conflict' | 'not-found' | 'bad-request';

export function domainViolation(error: unknown): DomainViolation {
  if (error instanceof DomainError) {
    switch (error.code) {
      case 'NotOwner':
      case 'NotAParticipant':
        return 'forbidden';
      case 'AlreadyHasAccess':
      case 'InvitationTargetMismatch':
      case 'CannotChangeOwnerAccess':
        return 'conflict';
      case 'TerminalNotInSession':
      case 'WorkspaceMismatch':
        return 'not-found';
      case 'EmptyCommand':
        return 'bad-request';
    }
  }
  throw error;
}
