// `@` is forbidden so a username can never equal someone's email: a login
// identifier containing `@` is always an email.
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const MAX = 32;

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

/** First free of `base`, `base2`, `base3`...; suffixed names stay within 32 chars. */
export async function pickAvailableUsername(
  base: string,
  isTaken: (username: string) => Promise<boolean>,
): Promise<string> {
  if (!(await isTaken(base))) return base;
  for (let n = 2; n < 10_000; n += 1) {
    const suffix = String(n);
    const candidate = `${base.slice(0, MAX - suffix.length)}${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error('no free username');
}
