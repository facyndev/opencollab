import { z } from 'zod';

// `.strict()` everywhere: unknown fields are rejected, not silently dropped.
export const createWorkspaceSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();

export type CreateWorkspaceBody = z.infer<typeof createWorkspaceSchema>;
