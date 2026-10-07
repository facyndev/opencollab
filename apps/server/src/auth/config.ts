import { isIP } from 'node:net';

import { PROVIDER_NAMES, type ProviderName } from './oauth-provider';

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export interface AuthConfig {
  jwtSecret: string;
  databaseUrl: string;
  publicBaseUrl: string;
  /** Origin of the web app: where OAuth callbacks for `client=web` redirect to (no trailing slash). */
  webOrigin: string;
  /** `loadAuthConfig` requires every provider; tests may wire fewer (others answer 404). */
  oauth: Partial<Record<ProviderName, ProviderCredentials>>;
  /** Tests switch it off; production always has it on. */
  rateLimitEnabled: boolean;
  /**
   * Express `trust proxy`: how many reverse-proxy hops (or which addresses) may
   * set `X-Forwarded-For`. Off by default; throttling then keys on the socket
   * address. Never `true`: trusting every hop lets any client spoof its IP.
   */
  trustProxy: false | number | string[];
}

export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

type Env = Record<string, string | undefined>;

const PROXY_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isTrustedProxyEntry(entry: string): boolean {
  if (PROXY_PRESETS.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split('/');
  const family = isIP(address ?? '');
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

/** `TRUST_PROXY`: unset/false/0 = off, a hop count, or a comma list of IPs, CIDRs and presets. */
function parseTrustProxy(raw: string | undefined): AuthConfig['trustProxy'] {
  const value = (raw ?? '').trim();
  if (value === '' || value.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value) === 0 ? false : Number(value);
  const entries = value.split(',').map((e) => e.trim());
  if (!entries.every(isTrustedProxyEntry)) {
    throw new Error(
      'TRUST_PROXY must be false, a hop count, or a comma-separated list of IPs, CIDRs or loopback/linklocal/uniquelocal',
    );
  }
  return entries;
}

/** Desktop's Vite owns 1420, so the web dev server takes 1421. */
const DEFAULT_WEB_ORIGIN = 'http://localhost:1421';

/** `WEB_ORIGIN`: an http(s) origin only (no path, query or credentials), since we redirect to it. */
function parseWebOrigin(raw: string | undefined): string {
  const value = (raw ?? DEFAULT_WEB_ORIGIN).trim();
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  const isOrigin =
    !!url &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    !url.username &&
    !url.password &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash;
  if (!url || !isOrigin) throw new Error('WEB_ORIGIN must be an http(s) origin such as https://app.example.com');
  return url.origin;
}

/** Throws on missing required settings so the server fails fast at startup. */
export function loadAuthConfig(env: Env): AuthConfig {
  const jwtSecret = env['JWT_SECRET'];
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('JWT_SECRET is required and must be at least 32 characters');
  }
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  // Every provider is required: a missing credential is a deploy mistake, not a disabled login.
  const oauth: AuthConfig['oauth'] = {};
  for (const name of PROVIDER_NAMES) {
    const prefix = name.toUpperCase();
    const clientId = env[`${prefix}_CLIENT_ID`];
    if (!clientId) throw new Error(`${prefix}_CLIENT_ID is required`);
    const clientSecret = env[`${prefix}_CLIENT_SECRET`];
    if (!clientSecret) throw new Error(`${prefix}_CLIENT_SECRET is required`);
    oauth[name] = { clientId, clientSecret };
  }
  return {
    jwtSecret,
    databaseUrl,
    publicBaseUrl: (env['PUBLIC_BASE_URL'] ?? 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    webOrigin: parseWebOrigin(env['WEB_ORIGIN']),
    oauth,
    rateLimitEnabled: true,
    trustProxy: parseTrustProxy(env['TRUST_PROXY']),
  };
}
