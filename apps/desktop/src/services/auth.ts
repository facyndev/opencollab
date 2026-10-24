// Login del desktop vía la web: PKCE S256 + deep link `opencollab://`.
// El verifier y los tokens nunca tocan `localStorage`: el verifier vive en
// memoria de este módulo (y en el núcleo tras `auth_begin_login`), los tokens
// solo en el núcleo. El núcleo revalida todo antes de canjear.

export type { AuthState, AuthUser } from "@opencollab/ui";
export { initialsOf } from "@opencollab/ui";

/** `true` si la URL es un callback de login del desktop (filtro rápido; el núcleo revalida). */
export function isAuthCallback(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "opencollab:" || parsed.protocol === "opencollab-dev:") &&
      parsed.host === "auth" &&
      parsed.pathname === "/callback" &&
      parsed.searchParams.get("code") !== null
    );
  } catch {
    return false;
  }
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Par PKCE: verifier aleatorio (32 bytes) y su challenge S256. */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

