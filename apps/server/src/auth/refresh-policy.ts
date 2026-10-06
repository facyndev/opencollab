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
