export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
}

export type AuthState =
  | { status: "unknown" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: AuthUser };

/** Iniciales para el avatar (hasta 2 letras, del nombre visible o del usuario). */
export function initialsOf(user: AuthUser): string {
  const source = user.displayName.trim() || user.username;
  const parts = source.split(/\s+/);
  const first = parts[0]?.charAt(0) ?? "?";
  const second = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? "") : "";
  return (first + second).toUpperCase();
}
