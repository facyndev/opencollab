import type { ProviderCredentials } from './config';
import { ProviderUnavailableError, type OAuthProviderPort, type ProviderProfile } from './oauth-provider';

type Fetch = typeof fetch;

/** Upper bound for a whole code exchange (all of its provider calls together). */
export const PROVIDER_TIMEOUT_MS = 10_000;

/** Aborts with the exchange's shared `signal`; any transport failure becomes a generic unavailable error. */
async function send(fetchFn: Fetch, signal: AbortSignal, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchFn(url, { ...init, signal });
  } catch {
    // Drop the cause: transport errors can carry URLs or request details.
    throw new ProviderUnavailableError();
  }
}

// The timeout also covers the body; an aborted or malformed body is a provider failure.
const readJson = (res: Response): Promise<unknown> =>
  res.json().catch(() => {
    throw new ProviderUnavailableError();
  });

async function postForm(fetchFn: Fetch, signal: AbortSignal, url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await send(fetchFn, signal, url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const json = (await readJson(res)) as Record<string, unknown>;
  if (!res.ok || typeof json['access_token'] !== 'string') {
    // Never include the response body: it can echo codes or secrets.
    throw new Error(`token exchange failed (${res.status})`);
  }
  return json;
}

async function getJson<T>(fetchFn: Fetch, signal: AbortSignal, url: string, accessToken: string): Promise<T> {
  const res = await send(fetchFn, signal, url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'opencollab-server',
    },
  });
  if (!res.ok) throw new Error(`provider request failed (${res.status})`);
  return (await readJson(res)) as T;
}

const authorize = (base: string, params: Record<string, string>): string =>
  `${base}?${new URLSearchParams(params).toString()}`;

export class GithubProvider implements OAuthProviderPort {
  readonly name = 'github' as const;

  constructor(
    private readonly creds: ProviderCredentials,
    private readonly fetchFn: Fetch = fetch,
    private readonly timeoutMs: number = PROVIDER_TIMEOUT_MS,
  ) {}

  authorizationUrl(i: { state: string; codeChallenge: string; redirectUri: string }): string {
    return authorize('https://github.com/login/oauth/authorize', {
      client_id: this.creds.clientId,
      redirect_uri: i.redirectUri,
      scope: 'read:user user:email',
      state: i.state,
      code_challenge: i.codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  async exchange(i: { code: string; codeVerifier: string; redirectUri: string }): Promise<ProviderProfile> {
    // One deadline for all three calls, not one per call.
    const signal = AbortSignal.timeout(this.timeoutMs);
    const token = await postForm(this.fetchFn, signal, 'https://github.com/login/oauth/access_token', {
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      code: i.code,
      redirect_uri: i.redirectUri,
      code_verifier: i.codeVerifier,
    });
    const accessToken = token['access_token'] as string;
    const user = await getJson<{ id: number; login: string; name: string | null }>(
      this.fetchFn,
      signal,
      'https://api.github.com/user',
      accessToken,
    );
    // The public profile email is unverified; only trust the primary verified one.
    const emails = await getJson<{ email: string; primary: boolean; verified: boolean }[]>(
      this.fetchFn,
      signal,
      'https://api.github.com/user/emails',
      accessToken,
    );
    const primary = emails.find((e) => e.primary && e.verified);
    return {
      providerUserId: String(user.id),
      login: user.login,
      displayName: user.name,
      email: primary?.email ?? null,
      emailVerified: Boolean(primary),
    };
  }
}

export class GoogleProvider implements OAuthProviderPort {
  readonly name = 'google' as const;

  constructor(
    private readonly creds: ProviderCredentials,
    private readonly fetchFn: Fetch = fetch,
    private readonly timeoutMs: number = PROVIDER_TIMEOUT_MS,
  ) {}

  authorizationUrl(i: { state: string; codeChallenge: string; redirectUri: string }): string {
    return authorize('https://accounts.google.com/o/oauth2/v2/auth', {
      client_id: this.creds.clientId,
      redirect_uri: i.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: i.state,
      code_challenge: i.codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  async exchange(i: { code: string; codeVerifier: string; redirectUri: string }): Promise<ProviderProfile> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const token = await postForm(this.fetchFn, signal, 'https://oauth2.googleapis.com/token', {
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      code: i.code,
      redirect_uri: i.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: i.codeVerifier,
    });
    const info = await getJson<{
      sub: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
    }>(this.fetchFn, signal, 'https://openidconnect.googleapis.com/v1/userinfo', token['access_token'] as string);
    const email = info.email ?? null;
    return {
      providerUserId: info.sub,
      login: email ? (email.split('@')[0] ?? null) : null,
      displayName: info.name ?? null,
      email,
      emailVerified: Boolean(email && info.email_verified),
    };
  }
}
