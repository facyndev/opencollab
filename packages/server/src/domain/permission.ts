// A single ordered level (none < view < write), not independent flags, so
// "write without view" cannot be represented. Same strings as the wire.
export type AccessLevel = 'none' | 'view' | 'write';

const RANK: Record<AccessLevel, number> = { none: 0, view: 1, write: 2 };
const BY_RANK: AccessLevel[] = ['none', 'view', 'write'];

// Level a participant starts with: view enabled.
export const DEFAULT_ACCESS: AccessLevel = 'view';

export const canView = (level: AccessLevel): boolean => RANK[level] >= RANK.view;
export const canWrite = (level: AccessLevel): boolean => RANK[level] >= RANK.write;

// Disabling view also revokes write (ends with no access).
export function withView(level: AccessLevel, enabled: boolean): AccessLevel {
  return enabled ? BY_RANK[Math.max(RANK[level], RANK.view)] : 'none';
}

// Enabling write also enables view; disabling it keeps view.
export function withWrite(level: AccessLevel, enabled: boolean): AccessLevel {
  return enabled ? 'write' : BY_RANK[Math.min(RANK[level], RANK.view)];
}
