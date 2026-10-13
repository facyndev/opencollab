import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';

import { isValidCodeChallenge } from './tokens';
import { isValidUsername } from './username';

const username = z.string().refine(isValidUsername, 'username must be 3-32 chars of [a-zA-Z0-9_-]');
const password = z.string().min(10).max(256);
const opaque = z.string().min(1).max(512);

// `.strict()` everywhere: unknown fields are rejected, not silently dropped.
export const registerSchema = z
  .object({
    username,
    email: z.email().max(254).optional(),
    password,
    displayName: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const loginSchema = z
  .object({ identifier: z.string().min(1).max(254), password: z.string().min(1).max(256) })
  .strict();

export const refreshSchema = z.object({ refreshToken: opaque }).strict();

export const desktopTokenSchema = z.object({ code: opaque, codeVerifier: opaque }).strict();

export const desktopCodeSchema = z
  .object({ code_challenge: z.string().refine(isValidCodeChallenge, 'invalid code_challenge') })
  .strict();

// Query strings are not strict: providers append their own parameters.
export const startQuerySchema = z.object({
  client: z.enum(['web', 'desktop']).default('web'),
  code_challenge: z.string().refine(isValidCodeChallenge, 'invalid code_challenge').optional(),
});

export const callbackQuerySchema = z.object({
  code: opaque.optional(),
  state: opaque.optional(),
  error: z.string().max(200).optional(),
});

export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    // Paths and rules only: never echo submitted values (they may be secrets).
    const message = result.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    throw new BadRequestException(message);
  }
}
