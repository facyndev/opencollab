/** Slack after the token's `exp` for clock skew and a renewal still in flight. */
export const TOKEN_GRACE_MS = 5_000;

// Node clamps longer timeouts to 1 ms; access tokens live minutes, this is only a guard.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * One connection's authentication deadline: the access token's expiry plus a
 * small grace. `set` (re)arms it, so a renewal just calls it again; `clear`
 * must run when the connection goes away so no timer outlives it.
 */
export class ConnectionDeadline {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly onExpire: () => void) {}

  /** `expiresAt` is unix seconds, as in the JWT `exp` claim. */
  set(expiresAt: number): void {
    this.clear();
    const delay = Math.min(Math.max(expiresAt * 1000 + TOKEN_GRACE_MS - Date.now(), 0), MAX_TIMEOUT_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onExpire();
    }, delay);
  }

  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
