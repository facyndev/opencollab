import {
  Session,
  newTerminal,
  type SessionGuest,
  type SessionId,
  type Terminal,
  type TerminalId,
  type UserId,
  type WorkspaceId,
} from '@opencollab/domain';
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
  terminals: {
    id: string;
    name: string;
    command: string;
    args: string[];
    cwd: string | null;
    agent: string | null;
    minimized: boolean;
  }[];
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

  // Removes the aggregate row; terminals, overrides, guests and invitations
  // follow the schema's onDelete cascade.
  async delete(id: SessionId): Promise<void> {
    // deleteMany over delete: an id raced away between the controller's
    // existence check and here must not turn into a P2025 500.
    await this.prisma.session.deleteMany({ where: { id } });
  }

  // Ownership projection for idempotent terminal creates (S7): the terminal
  // and the owner of the workspace its session belongs to. Undefined when the
  // id is free (globally unique primary key).
  async terminalWithOwner(id: TerminalId): Promise<{ terminal: Terminal; ownerId: UserId } | undefined> {
    const row = await this.prisma.terminal.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        command: true,
        args: true,
        cwd: true,
        agent: true,
        minimized: true,
        session: { select: { workspace: { select: { ownerId: true } } } },
      },
    });
    if (!row) return undefined;
    const terminal = newTerminal(
      row.id as TerminalId,
      {
        name: row.name,
        command: row.command,
        args: row.args,
        env: [],
        ...(row.cwd === null ? {} : { cwd: row.cwd }),
      },
      { agent: row.agent, minimized: row.minimized },
    );
    return { terminal, ownerId: row.session.workspace.ownerId as UserId };
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
          // Snapshot metadata (S7); a missing key means the domain default.
          agent: t.agent ?? null,
          minimized: t.minimized ?? false,
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
  // Terminal.env is NOT persisted (secrets): rehydrated as [], always.
  const terminals: Terminal[] = row.terminals.map((t) =>
    newTerminal(
      t.id as TerminalId,
      {
        name: t.name,
        command: t.command,
        args: t.args,
        env: [],
        ...(t.cwd === null ? {} : { cwd: t.cwd }),
      },
      { agent: t.agent, minimized: t.minimized },
    ),
  );
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
