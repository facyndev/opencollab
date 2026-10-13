import { randomInt } from 'node:crypto';

// `@` is forbidden so a username can never equal someone's email: a login
// identifier containing `@` is always an email.
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const MAX = 32;
const SUFFIX_LENGTH = 6;
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Random-suffix retries after the bare base is taken; each one is a fresh draw. */
export const MAX_USERNAME_ATTEMPTS = 5;

export const isValidUsername = (value: string): boolean => USERNAME_RE.test(value);

/** Maps arbitrary provider text to a valid username (never throws). */
export function sanitizeUsername(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, MAX)
    .replace(/[-_]+$/g, '');
  if (cleaned.length >= 3) return cleaned;
  return `${cleaned || 'user'}-user`.slice(0, MAX);
}

export function randomSuffix(): string {
  let out = '';
  for (let i = 0; i < SUFFIX_LENGTH; i += 1) out += SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)];
  return out;
}

/**
 * `base` if free, else `base-<random>` (bounded attempts, within 32 chars). A
 * random suffix instead of `base2`, `base3`...: no linear probing (one query
 * per taken name) and concurrent signups with the same base rarely collide.
 */
export async function pickAvailableUsername(
  base: string,
  isTaken: (username: string) => Promise<boolean>,
  suffix: () => string = randomSuffix,
): Promise<string> {
  if (!(await isTaken(base))) return base;
  for (let attempt = 0; attempt < MAX_USERNAME_ATTEMPTS; attempt += 1) {
    const tail = `-${suffix()}`;
    const candidate = `${base.slice(0, MAX - tail.length)}${tail}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error('no free username');
}
