import { createHmac } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { deriveKey as keyFor } from './keys';
import type { ProviderName } from './oauth-provider';

export interface OAuthState {
  provider: ProviderName;
  intent: 'login' | 'link';
  client: 'web' | 'desktop';
  /** Random per flow; also derives the provider-side PKCE verifier. */
  nonce: string;
  /** Random per flow; names the browser-binding cookie so parallel flows do not clash. */
  flow: string;
  /** Hash of the browser-binding cookie value set when the flow started. */
  binding: string;
  /** Desktop only: the desktop's own S256 challenge. */
  codeChallenge?: string;
  /** Link intent only: the authenticated user starting the link. */
  linkUserId?: string;
}

/** Lifetime of a signed state; the browser-binding cookie lives exactly as long. */
export const STATE_TTL_SECONDS = 10 * 60;
const AUDIENCE = 'oauth-state';

const seconds = (d: Date): number => Math.floor(d.getTime() / 1000);

export function signState(payload: OAuthState, secret: string, now: Date): string {
  return jwt.sign({ ...payload, iat: seconds(now), exp: seconds(now) + STATE_TTL_SECONDS }, keyFor(secret, AUDIENCE), {
    algorithm: 'HS256',
    audience: AUDIENCE,
  });
}

export function verifyState(token: string, secret: string, now: Date): OAuthState | undefined {
  try {
    const claims = jwt.verify(token, keyFor(secret, AUDIENCE), {
      algorithms: ['HS256'],
      audience: AUDIENCE,
      clockTimestamp: seconds(now),
    }) as jwt.JwtPayload;
    const { provider, intent, client, nonce, flow, binding, codeChallenge, linkUserId } = claims;
    if (typeof flow !== 'string' || !flow) return undefined;
    return {
      provider,
      intent,
      client,
      nonce,
      flow,
      binding,
      ...(codeChallenge ? { codeChallenge } : {}),
      ...(linkUserId ? { linkUserId } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Provider-side PKCE verifier, derived from the server secret and the state
 * nonce: the browser sees the challenge and the state, never the verifier.
 */
export const pkceVerifierFor = (secret: string, nonce: string): string =>
  createHmac('sha256', keyFor(secret, 'oauth-pkce')).update(nonce).digest('base64url');
