import { PROVIDER_NAMES, type ProviderName } from './oauth-provider';

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export interface AuthConfig {
  jwtSecret: string;
  databaseUrl: string;
  publicBaseUrl: string;
  /** Only providers with both id and secret are present (others answer 404). */
  oauth: Partial<Record<ProviderName, ProviderCredentials>>;
  /** Tests switch it off; production always has it on. */
  rateLimitEnabled: boolean;
}

export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

type Env = Record<string, string | undefined>;

/** Throws on missing required settings so the server fails fast at startup. */
export function loadAuthConfig(env: Env): AuthConfig {
  const jwtSecret = env['JWT_SECRET'];
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('JWT_SECRET is required and must be at least 32 characters');
  }
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const oauth: AuthConfig['oauth'] = {};
  for (const name of PROVIDER_NAMES) {
    const prefix = name.toUpperCase();
    const clientId = env[`${prefix}_CLIENT_ID`];
    const clientSecret = env[`${prefix}_CLIENT_SECRET`];
    if (clientId && clientSecret) oauth[name] = { clientId, clientSecret };
  }
  return {
    jwtSecret,
    databaseUrl,
    publicBaseUrl: (env['PUBLIC_BASE_URL'] ?? 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    oauth,
    rateLimitEnabled: true,
  };
}
