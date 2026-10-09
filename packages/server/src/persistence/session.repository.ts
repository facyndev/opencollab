import {
  Session,
  type SessionGuest,
  type SessionId,
  type Terminal,
  type TerminalId,
  type UserId,
  type WorkspaceId,
} from '../domain';
import type { PrismaClient } from '../generated/prisma/client';
import type { AccessLevel as DbAccessLevel } from '../generated/prisma/enums';
import { accessFromDb, accessToDb } from './mappers';

const INCLUDE = {
  terminals: { orderBy: { position: 'asc' } },
  overrides: true,
  guests: true,
} as const;

interface SessionRow {
  id: string;
  workspaceId: string;
  name: string;
  terminals: { id: string; name: string; command: string; args: string[]; cwd: string | null }[];
  overrides: { userId: string; access: DbAccessLevel }[];
  guests: { userId: string; access: DbAccessLevel }[];
}

// Aggregate-level port: the whole Session (terminals, overrides, guests).
//
// Only explicit overrides are stored; a member without a row resolves to the
// default (view) in the domain, so effective access is never persisted.
//
// Terminal.env is NOT persisted: it may hold secrets. It is always written as
// [] and rehydrated as [], so a reloaded profile never carries env.
export class SessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async find(id: SessionId): Promise<Session | undefined> {
    const row = await this.prisma.session.findUnique({ where: { id }, include: INCLUDE });
    return row ? restore(row) : undefined;
  }

  async listByWorkspace(workspaceId: WorkspaceId): Promise<Session[]> {
    const rows = await this.prisma.session.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      include: INCLUDE,
    });
    return rows.map(restore);
  }

  // Upserts the session and replaces its terminals (position = index),
  // overrides and guests, all in one transaction.
  async save(session: Session): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.session.upsert({
        where: { id: session.id },
        create: { id: session.id, workspaceId: session.workspaceId, name: session.name },
        update: { name: session.name },
      }),
      this.prisma.terminal.deleteMany({ where: { sessionId: session.id } }),
      this.prisma.terminal.createMany({
        data: session.terminals.map((t, position) => ({
          id: t.id,
          sessionId: session.id,
          position,
          name: t.profile.name,
          command: t.profile.command,
          args: t.profile.args,
          cwd: t.profile.cwd ?? null,
          env: [],
        })),
      }),
      this.prisma.sessionAccessOverride.deleteMany({ where: { sessionId: session.id } }),
      this.prisma.sessionAccessOverride.createMany({
        data: session.overrides.map(([userId, level]) => ({
          sessionId: session.id,
          userId,
          access: accessToDb(level),
        })),
      }),
      this.prisma.sessionGuest.deleteMany({ where: { sessionId: session.id } }),
      this.prisma.sessionGuest.createMany({
        data: session.guests.map((g) => ({
          sessionId: session.id,
          userId: g.userId,
          access: accessToDb(g.access),
        })),
      }),
    ]);
  }
}

function restore(row: SessionRow): Session {
  const terminals: Terminal[] = row.terminals.map((t) => ({
    id: t.id as TerminalId,
    profile: {
      name: t.name,
      command: t.command,
      args: t.args,
      env: [],
      ...(t.cwd === null ? {} : { cwd: t.cwd }),
    },
  }));
  const guests: SessionGuest[] = row.guests.map((g) => ({
    userId: g.userId as UserId,
    access: accessFromDb(g.access),
  }));
  return Session.restore({
    id: row.id as SessionId,
    workspaceId: row.workspaceId as WorkspaceId,
    name: row.name,
    terminals,
    overrides: row.overrides.map((o) => [o.userId as UserId, accessFromDb(o.access)] as const),
    guests,
  });
}
