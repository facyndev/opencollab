// Desktop handoff: the desktop opens /login?client=desktop&code_challenge=<S256>.
// Only the PKCE challenge (a public value) is kept in sessionStorage so it
// survives the OAuth round trip; tokens never touch storage.

const KEY = "opencollab.handoff.challenge";
const DEEP_LINK_PREFIX = "opencollab://";

// S256 challenge: base64url of a 32-byte digest is always 43 chars.
export const isValidCodeChallenge = (value: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(value);

export function readPendingHandoff(): string | null {
  try {
    const value = sessionStorage.getItem(KEY);
    return value && isValidCodeChallenge(value) ? value : null;
  } catch {
    return null;
  }
}

export function clearPendingHandoff(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: nothing was persisted.
  }
}

/**
 * Reads a handoff request from a query string. A valid one replaces any pending
 * challenge; an explicit but invalid desktop request clears a stale one; a URL
 * with no handoff parameters leaves the pending state untouched (OAuth return
 * trips carry none).
 */
export function captureHandoff(search: string): boolean {
  const params = new URLSearchParams(search);
  const client = params.get("client");
  const challenge = params.get("code_challenge");
  if (client === null && challenge === null) return false;
  if (client === "desktop" && challenge !== null && isValidCodeChallenge(challenge)) {
    try {
      sessionStorage.setItem(KEY, challenge);
    } catch {
      // Without storage the handoff only survives password login (no OAuth trip).
    }
    return true;
  }
  clearPendingHandoff();
  return false;
}

/** Exchanges the pending challenge for a deep link and navigates to it. Returns whether a handoff ran. */
export async function runPendingHandoff(
  api: { desktopCode(challenge: string): Promise<string> },
  assign: (url: string) => void,
): Promise<boolean> {
  const challenge = readPendingHandoff();
  if (!challenge) return false;
  const redirectUrl = await api.desktopCode(challenge);
  if (!redirectUrl.startsWith(DEEP_LINK_PREFIX)) throw new Error("Unexpected redirect target");
  clearPendingHandoff();
  assign(redirectUrl);
  return true;
}
