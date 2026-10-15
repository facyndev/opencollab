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
