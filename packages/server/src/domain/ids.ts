import { randomUUID } from 'node:crypto';

import { InvalidIdError } from './error';

// Branded UUID strings: ids of different aggregates are not interchangeable.
type Id<Brand extends string> = string & { readonly __brand: Brand };

export type UserId = Id<'UserId'>;
export type WorkspaceId = Id<'WorkspaceId'>;
export type SessionId = Id<'SessionId'>;
export type TerminalId = Id<'TerminalId'>;
export type InvitationId = Id<'InvitationId'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parse<T extends string>(value: string): T {
  if (!UUID.test(value)) throw new InvalidIdError(value);
  return value as T;
}

export const newUserId = (): UserId => randomUUID() as UserId;
export const newWorkspaceId = (): WorkspaceId => randomUUID() as WorkspaceId;
export const newSessionId = (): SessionId => randomUUID() as SessionId;
export const newTerminalId = (): TerminalId => randomUUID() as TerminalId;
export const newInvitationId = (): InvitationId => randomUUID() as InvitationId;

export const parseUserId = (s: string): UserId => parse<UserId>(s);
export const parseWorkspaceId = (s: string): WorkspaceId => parse<WorkspaceId>(s);
export const parseSessionId = (s: string): SessionId => parse<SessionId>(s);
export const parseTerminalId = (s: string): TerminalId => parse<TerminalId>(s);
export const parseInvitationId = (s: string): InvitationId => parse<InvitationId>(s);
