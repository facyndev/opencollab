import { z } from 'zod';

// `.strict()` everywhere: unknown fields are rejected, not silently dropped.
export const createWorkspaceSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();

export type CreateWorkspaceBody = z.infer<typeof createWorkspaceSchema>;

// Session name follows the same rule as the workspace name (S4).
export const createSessionSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();

export type CreateSessionBody = z.infer<typeof createSessionSchema>;

// S7 body. `env` is deliberately absent: the strict schema rejects it, so a
// client can never smuggle secrets into a terminal profile. `command` cannot
// be blank (domain EmptyCommand) but keeps the caller's exact spacing; the
// blank check does not echo the submitted value (S14).
export const addTerminalSchema = z
  .object({
    name: z.string(),
    command: z.string().refine((value) => value.trim() !== '', { message: 'command must not be blank' }),
    args: z.array(z.string()).optional(),
    cwd: z.string().nullable().optional(),
  })
  .strict();

export type AddTerminalBody = z.infer<typeof addTerminalSchema>;

// S9/S10 body. The uuid message names the rule, never the submitted value
// (S14: ZodPipe only emits field paths and messages).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const inviteSchema = z
  .object({ inviteeId: z.string().regex(UUID, { message: 'must be a uuid' }) })
  .strict();

export type InviteBody = z.infer<typeof inviteSchema>;

// Malformed invitation ids answer 404, never 500: Postgres uuid columns throw
// on non-uuid input, so the format is pre-checked before Prisma sees it.
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
