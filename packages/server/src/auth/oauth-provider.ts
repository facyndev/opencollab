export const PROVIDER_NAMES = ['github', 'google'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export const isProviderName = (value: string): value is ProviderName =>
  (PROVIDER_NAMES as readonly string[]).includes(value);

export interface ProviderProfile {
  providerUserId: string;
  /** Preferred handle (GitHub login) or email local-part; used for the username. */
  login: string | null;
  displayName: string | null;
  email: string | null;
  /** True only when the provider asserts that `email` is verified. */
  emailVerified: boolean;
}

/** The provider could not be reached in time (timeout or network failure). */
export class ProviderUnavailableError extends Error {
  constructor() {
    super('provider unavailable');
  }
}

/** Port: the only place that talks to GitHub/Google over HTTP. */
export interface OAuthProviderPort {
  readonly name: ProviderName;
  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchange(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<ProviderProfile>;
}

export const OAUTH_PROVIDERS = Symbol('OAUTH_PROVIDERS');
export type OAuthProviders = Partial<Record<ProviderName, OAuthProviderPort>>;
