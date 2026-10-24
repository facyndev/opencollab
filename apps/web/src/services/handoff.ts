// Desktop handoff: the desktop opens /login?client=desktop&code_challenge=<S256>.
// Only the PKCE challenge (a public value) is kept in sessionStorage so it
// survives the OAuth round trip; tokens never touch storage.

const KEY = "opencollab.handoff.challenge";
const CLIENT_KEY = "opencollab.handoff.client";
const DEEP_LINK_PREFIXES = ["opencollab://", "opencollab-dev://"];

export type DesktopHandoffClient = "desktop" | "desktop-dev";

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

export function readPendingHandoffClient(): DesktopHandoffClient {
  try {
    return sessionStorage.getItem(CLIENT_KEY) === "desktop-dev" ? "desktop-dev" : "desktop";
  } catch {
    return "desktop";
  }
}

export function clearPendingHandoff(): void {
  try {
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(CLIENT_KEY);
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
  if ((client === "desktop" || client === "desktop-dev") && challenge !== null && isValidCodeChallenge(challenge)) {
    try {
      sessionStorage.setItem(KEY, challenge);
      if (client === "desktop-dev") {
        sessionStorage.setItem(CLIENT_KEY, "desktop-dev");
      } else {
        sessionStorage.removeItem(CLIENT_KEY);
      }
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
  api: { desktopCode(challenge: string, client?: DesktopHandoffClient): Promise<string> },
  assign: (url: string) => void,
): Promise<boolean> {
  const challenge = readPendingHandoff();
  if (!challenge) return false;
  const client = readPendingHandoffClient();
  const redirectUrl =
    client === "desktop-dev" ? await api.desktopCode(challenge, "desktop-dev") : await api.desktopCode(challenge);
  if (!DEEP_LINK_PREFIXES.some((prefix) => redirectUrl.startsWith(prefix))) {
    throw new Error("Unexpected redirect target");
  }
  clearPendingHandoff();
  assign(redirectUrl);
  return true;
}

/** Called once from the entry point, before the first render: a desktop request arrives on /login. */
export function captureInitialHandoff(location: { pathname: string; search: string }): void {
  if (location.pathname === "/login") captureHandoff(location.search);
}
