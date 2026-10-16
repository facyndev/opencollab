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
