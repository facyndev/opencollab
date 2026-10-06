import { describe, expect, it } from 'vitest';

import { ProviderUnavailableError } from './oauth-provider';
import { GithubProvider, GoogleProvider } from './providers';

type Call = { url: string; init?: RequestInit };

function stubFetch(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = routes[url];
    if (body === undefined) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const creds = { clientId: 'cid', clientSecret: 'csecret' };
const redirectUri = 'http://localhost:8787/auth/oauth/github/callback';

describe('GithubProvider', () => {
  it('builds an authorization URL with state and S256 PKCE', () => {
    const url = new URL(
      new GithubProvider(creds).authorizationUrl({ state: 's', codeChallenge: 'c', redirectUri }),
    );
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('state')).toBe('s');
    expect(url.searchParams.get('code_challenge')).toBe('c');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
  });

  it('exchanges the code and uses only a primary verified email', async () => {
    const { fn, calls } = stubFetch({
      'https://github.com/login/oauth/access_token': { access_token: 'tok' },
      'https://api.github.com/user': { id: 42, login: 'octo', name: 'Octo Cat', email: 'public@x.com' },
      'https://api.github.com/user/emails': [
        { email: 'other@x.com', primary: false, verified: true },
        { email: 'main@x.com', primary: true, verified: true },
      ],
    });
    const profile = await new GithubProvider(creds, fn).exchange({
      code: 'code',
      codeVerifier: 'ver',
      redirectUri,
    });
    expect(profile).toEqual({
      providerUserId: '42',
      login: 'octo',
      displayName: 'Octo Cat',
      email: 'main@x.com',
      emailVerified: true,
    });
    const body = String(calls[0]?.init?.body);
    expect(body).toContain('code_verifier=ver');
    expect(body).toContain('client_secret=csecret');
  });

  it('reports no email when none is verified', async () => {
    const { fn } = stubFetch({
      'https://github.com/login/oauth/access_token': { access_token: 'tok' },
      'https://api.github.com/user': { id: 1, login: 'a', name: null, email: 'x@x.com' },
      'https://api.github.com/user/emails': [{ email: 'x@x.com', primary: true, verified: false }],
    });
    const profile = await new GithubProvider(creds, fn).exchange({ code: 'c', codeVerifier: 'v', redirectUri });
    expect(profile.email).toBeNull();
    expect(profile.emailVerified).toBe(false);
    expect(profile.displayName).toBeNull();
  });

  it('throws when the token endpoint returns an error', async () => {
    const { fn } = stubFetch({
      'https://github.com/login/oauth/access_token': { error: 'bad_verification_code' },
    });
    await expect(
      new GithubProvider(creds, fn).exchange({ code: 'c', codeVerifier: 'v', redirectUri }),
    ).rejects.toThrow();
  });
});

describe('GoogleProvider', () => {
  it('builds an authorization URL with openid scopes and S256 PKCE', () => {
    const url = new URL(
      new GoogleProvider(creds).authorizationUrl({ state: 's', codeChallenge: 'c', redirectUri }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('maps userinfo to a profile honoring email_verified', async () => {
    const { fn } = stubFetch({
      'https://oauth2.googleapis.com/token': { access_token: 'tok' },
      'https://openidconnect.googleapis.com/v1/userinfo': {
        sub: 'g-1',
        email: 'jane@example.com',
        email_verified: true,
        name: 'Jane',
      },
    });
    expect(
      await new GoogleProvider(creds, fn).exchange({ code: 'c', codeVerifier: 'v', redirectUri }),
    ).toEqual({
      providerUserId: 'g-1',
      login: 'jane',
      displayName: 'Jane',
      email: 'jane@example.com',
      emailVerified: true,
    });
  });
});

describe('provider timeouts', () => {
  // Never resolves on its own; rejects only when the caller's signal aborts.
  const hangingFetch = (() => {
    const seen: { signal?: AbortSignal | null }[] = [];
    const fn = ((_input: unknown, init?: RequestInit) => {
      seen.push({ signal: init?.signal });
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as unknown as typeof fetch;
    return { fn, seen };
  })();
  const input = { code: 'c', codeVerifier: 'v', redirectUri };

  it.each([
    ['github', (fn: typeof fetch) => new GithubProvider(creds, fn, 20)],
    ['google', (fn: typeof fetch) => new GoogleProvider(creds, fn, 20)],
  ])('%s: aborts a hung request and reports it as unavailable', async (_name, make) => {
    await expect(make(hangingFetch.fn).exchange(input)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(hangingFetch.seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a network failure as unavailable without leaking its message', async () => {
    const boom = (async () => {
      throw new Error('connect ECONNREFUSED secret-token-123');
    }) as typeof fetch;
    const error = await new GithubProvider(creds, boom, 20).exchange(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(String((error as Error).message)).not.toContain('secret-token-123');
  });
});
