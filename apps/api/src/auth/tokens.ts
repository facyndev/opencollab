import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes as base64url (256 bits). */
export const generateToken = (): string => randomBytes(32).toString('base64url');

/** Only this hash is stored; the token itself never touches the DB. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

// S256 challenge: base64url of a 32-byte digest is always 43 chars.
export const isValidCodeChallenge = (value: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(value);

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier) return false;
  const a = Buffer.from(s256(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}
