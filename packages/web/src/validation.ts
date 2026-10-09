// Client-side checks that mirror the server's zod schemas (packages/server/src/auth/dto.ts).
// The server stays the authority; this only saves a round trip and explains the rule.

export interface RegisterValues {
  username: string;
  password: string;
  email: string;
  displayName: string;
}

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

const USERNAME = /^[a-zA-Z0-9_-]{3,32}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRegister(values: RegisterValues): FieldErrors<keyof RegisterValues> {
  const errors: FieldErrors<keyof RegisterValues> = {};
  if (!USERNAME.test(values.username)) {
    errors.username = "Username must be 3-32 characters: letters, digits, _ or -.";
  }
  if (values.password.length < 10) errors.password = "Password must be at least 10 characters.";
  else if (values.password.length > 256) errors.password = "Password must be at most 256 characters.";
  const email = values.email.trim();
  if (email && (email.length > 254 || !EMAIL.test(email))) errors.email = "Enter a valid email address.";
  if (values.displayName.trim().length > 64) errors.displayName = "Display name must be at most 64 characters.";
  return errors;
}

export function validateLogin(values: { identifier: string; password: string }): FieldErrors<"identifier" | "password"> {
  const errors: FieldErrors<"identifier" | "password"> = {};
  if (!values.identifier.trim()) errors.identifier = "Enter your username or email.";
  if (!values.password) errors.password = "Enter your password.";
  return errors;
}

const OAUTH_ERRORS: Record<string, string> = {
  access_denied: "Sign-in was cancelled at the provider.",
  invalid_state: "The sign-in attempt expired or was invalid. Please try again.",
  conflict: "That provider account is already linked to a different user.",
  provider_unavailable: "The provider is not available right now. Try again later.",
  failed: "Sign-in failed. Please try again.",
};

/** Maps a `?error=` code to a fixed message. Unknown codes are never echoed. */
export function oauthErrorMessage(code: string | null): string | null {
  if (code === null) return null;
  return Object.hasOwn(OAUTH_ERRORS, code) ? OAUTH_ERRORS[code]! : OAUTH_ERRORS.failed!;
}
