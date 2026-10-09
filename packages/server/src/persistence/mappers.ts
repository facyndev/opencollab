import type { AccessLevel } from '../domain';
import type { AccessLevel as DbAccessLevel } from '../generated/prisma/enums';

const TO_DB: Record<AccessLevel, DbAccessLevel> = { none: 'NONE', view: 'VIEW', write: 'WRITE' };
const FROM_DB: Record<DbAccessLevel, AccessLevel> = { NONE: 'none', VIEW: 'view', WRITE: 'write' };

export const accessToDb = (level: AccessLevel): DbAccessLevel => TO_DB[level];
export const accessFromDb = (level: DbAccessLevel): AccessLevel => FROM_DB[level];
