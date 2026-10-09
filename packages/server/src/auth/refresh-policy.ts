export type RefreshVerdict = 'valid' | 'unknown' | 'expired' | 'reuse';

/**
 * Presenting a revoked token means it was already rotated (or its family was
 * revoked): `reuse`, and the caller must revoke the whole family.
 */
export function classifyRefresh(
  row: { revokedAt: Date | null; expiresAt: Date } | undefined,
  now: Date,
): RefreshVerdict {
  if (!row) return 'unknown';
  if (row.revokedAt) return 'reuse';
  return row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'valid';
}

/** How long after a rotation the web route still accepts the rotated token (concurrent tabs). */
export const WEB_REFRESH_GRACE_MS = 10_000;

export type WebRefreshVerdict = RefreshVerdict | 'grace';

/**
 * Web variant of `classifyRefresh`. Two tabs share one cookie, so the second
 * one may present the token the first just rotated. A token rotated less than
 * `WEB_REFRESH_GRACE_MS` ago whose family is still alive (`familyAlive`: some
 * token of it is unrevoked and unexpired) is `grace`: the caller may mint an
 * access token for that family but must neither rotate nor hand out a refresh
 * token. `revokedAt` is the rotation time here; a family revocation is told
 * apart by `familyAlive` being false.
 */
export function classifyWebRefresh(
  row: { revokedAt: Date | null; expiresAt: Date } | undefined,
  familyAlive: boolean,
  now: Date,
): WebRefreshVerdict {
  const verdict = classifyRefresh(row, now);
  if (verdict !== 'reuse' || !row?.revokedAt || !familyAlive) return verdict;
  const age = now.getTime() - row.revokedAt.getTime();
  const live = row.expiresAt.getTime() > now.getTime();
  return live && age < WEB_REFRESH_GRACE_MS ? 'grace' : 'reuse';
}
