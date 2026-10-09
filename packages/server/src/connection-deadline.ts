/** Slack after the token's `exp` for clock skew and a renewal still in flight. */
export const TOKEN_GRACE_MS = 5_000;

// Node clamps longer timeouts to 1 ms; access tokens live minutes, this is only a guard.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * One connection's authentication deadline: the access token's expiry plus a
 * small grace. `extend` arms it and only ever moves it later, so a renewal
 * with an older (but still valid) token cannot shorten the connection's life;
 * `clear` must run when the connection goes away so no timer outlives it.
 */
export class ConnectionDeadline {
  private timer: NodeJS.Timeout | undefined;
  private expiresAt = -Infinity;

  constructor(private readonly onExpire: () => void) {}

  /**
   * `expiresAt` is unix seconds, as in the JWT `exp` claim. Returns the expiry
   * now in force: the later of the current one and `expiresAt`.
   */
  extend(expiresAt: number): number {
    if (expiresAt <= this.expiresAt) return this.expiresAt;
    this.expiresAt = expiresAt;
    this.clear();
    const delay = Math.min(Math.max(expiresAt * 1000 + TOKEN_GRACE_MS - Date.now(), 0), MAX_TIMEOUT_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onExpire();
    }, delay);
    return expiresAt;
  }

  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
