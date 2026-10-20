import { z } from 'zod';

// The uuid message names the rule, never the submitted value (S14: ZodPipe
// only emits field paths and messages).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Explicit ids are uuids, normalized to lowercase so the same id string always
// matches the same row regardless of the casing the client chose.
function uuidId() {
  return z.string().regex(UUID, { message: 'must be a uuid' }).transform((value) => value.toLowerCase());
}

// `.strict()` everywhere: unknown fields are rejected, not silently dropped.
export const createWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    // S7: an explicit uuid makes the create idempotent for its owner.
    id: uuidId().optional(),
  })
  .strict();

export type CreateWorkspaceBody = z.infer<typeof createWorkspaceSchema>;

// Session name follows the same rule as the workspace name (S4).
export const createSessionSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    id: uuidId().optional(),
  })
  .strict();

export type CreateSessionBody = z.infer<typeof createSessionSchema>;

// S7 body. `env` is deliberately absent: the strict schema rejects it, so a
// client can never smuggle secrets into a terminal profile. `command` cannot
// be blank (domain EmptyCommand) but keeps the caller's exact spacing; the
// blank check does not echo the submitted value (S14).
export const addTerminalSchema = z
  .object({
    id: uuidId().optional(),
    name: z.string(),
    command: z.string().refine((value) => value.trim() !== '', { message: 'command must not be blank' }),
    args: z.array(z.string()).optional(),
    cwd: z.string().nullable().optional(),
    // Snapshot metadata: which agent the pane launches (null = plain shell).
    agent: z.string().nullable().optional(),
    minimized: z.boolean().optional(),
  })
  .strict();

export type AddTerminalBody = z.infer<typeof addTerminalSchema>;

// S7 bodies. Rename is a rename: `name` is required. The terminal patch is
// partial — absent keys keep the current value, null clears `cwd`/`agent`.
export const renameWorkspaceSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();

export type RenameWorkspaceBody = z.infer<typeof renameWorkspaceSchema>;

export const renameSessionSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();

export type RenameSessionBody = z.infer<typeof renameSessionSchema>;

export const updateTerminalSchema = z
  .object({
    name: z.string().optional(),
    command: z
      .string()
      .refine((value) => value.trim() !== '', { message: 'command must not be blank' })
      .optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().nullable().optional(),
    agent: z.string().nullable().optional(),
    minimized: z.boolean().optional(),
  })
  .strict();

export type UpdateTerminalBody = z.infer<typeof updateTerminalSchema>;

export const reorderTerminalsSchema = z
  .object({ ids: z.array(uuidId()) })
  .strict();

export type ReorderTerminalsBody = z.infer<typeof reorderTerminalsSchema>;

// S9/S10 body.
export const inviteSchema = z
  .object({ inviteeId: z.string().regex(UUID, { message: 'must be a uuid' }) })
  .strict();

export type InviteBody = z.infer<typeof inviteSchema>;

// Malformed invitation ids answer 404, never 500: Postgres uuid columns throw
// on non-uuid input, so the format is pre-checked before Prisma sees it.
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
