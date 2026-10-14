export type RevocationListener = (familyId: string) => void;

/**
 * In-process port: auth announces which refresh family was revoked, and
 * whoever holds live state for it (the collaboration gateway) reacts. Auth
 * never learns who listens. Only the family id travels, never a token.
 */
export class SessionRevocations {
  private readonly listeners = new Set<RevocationListener>();

  /** Returns the function that removes the listener. */
  subscribe(listener: RevocationListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  publish(familyId: string): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(familyId);
      } catch {
        // One failing listener must not stop the others or fail the revocation.
      }
    }
  }
}
