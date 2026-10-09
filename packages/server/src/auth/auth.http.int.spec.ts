import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { truncateAll } from '../persistence/test-db';
import { ProviderUnavailableError, type ProviderProfile } from './oauth-provider';
import { startTestApp, type TestApp } from './test-app';
import { s256 } from './tokens';

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp({ providers: ['github'] });
});
afterAll(() => t.close());
beforeEach(() => truncateAll(t.prisma));

interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  location: string | null;
  setCookie: string | null;
  setCookies: string[];
}

const WEB = 'http://web.test';
const CSRF = { 'X-OpenCollab-CSRF': '1' };

async function call(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  cookie?: string,
  headers: Record<string, string> = {},
): Promise<Res> {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, location: res.headers.get('location'),
    setCookie: res.headers.get('set-cookie'),
    setCookies: res.headers.getSetCookie(),
  };
}

const post = (path: string, body?: unknown, token?: string) => call('POST', path, body ?? {}, token);
// A browser call to a web route: the refresh cookie plus the anti-CSRF header.
const webPost = (path: string, body?: unknown, cookie?: string, headers: Record<string, string> = CSRF) =>
  call('POST', path, body, undefined, cookie, headers);

// The `oc_refresh=...` pair of a response, as a browser would send it back.
const refreshPair = (res: Res): string => {
  const header = res.setCookies.find((c) => c.startsWith('oc_refresh='));
  expect(header, 'no oc_refresh Set-Cookie').toBeTruthy();
  return (header as string).split(';')[0] as string;
};
const get = (path: string, token?: string, cookie?: string) =>
  call('GET', path, undefined, token, cookie);

// The `name=value` pair a browser would send back for a Set-Cookie header.
const cookieOf = (res: Res): string => {
  expect(res.setCookie).toBeTruthy();
  return (res.setCookie as string).split(';')[0] as string;
};

const credentials = {
  username: 'jane',
  email: 'Jane@Example.com',
  password: 'correct horse battery',
};
const register = (extra: object = {}) =>
  post('/auth/register', { ...credentials, displayName: 'Jane', ...extra });

const profile = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
  providerUserId: 'gh-1',
  login: 'octo',
  displayName: 'Octo Cat',
  email: 'octo@example.com',
  emailVerified: true,
  ...over,
});

const stateFrom = (location: string | null): string => {
  expect(location).toContain('https://fake.test/github/authorize');
  return new URL(location as string).searchParams.get('state') as string;
};

async function oauthLogin(code: string, p: ProviderProfile, query = ''): Promise<Res> {
  t.github.profiles.set(code, p);
  const start = await get(`/auth/oauth/github/start${query}`);
  expect(start.status).toBe(302);
  return get(
    `/auth/oauth/github/callback?code=${code}&state=${encodeURIComponent(stateFrom(start.location))}`,
    undefined,
    cookieOf(start),
  );
}

// Finishes a web OAuth login and resolves the session it opened (via the cookie).
async function oauthUser(code: string, p: ProviderProfile, query = '') {
  const cb = await oauthLogin(code, p, query);
  expect(cb.status).toBe(302);
  const refreshed = await webPost('/auth/web/refresh', undefined, refreshPair(cb));
  expect(refreshed.status).toBe(200);
  const me = await get('/auth/me', refreshed.body.accessToken);
  return { user: me.body, accessToken: refreshed.body.accessToken as string };
}

describe('register and login', () => {
  it('registers, returns tokens, and logs in by username and by email (any case)', async () => {
    const reg = await register();
    expect(reg.status).toBe(201);
    expect(reg.body.accessToken).toBeTruthy();
    expect(reg.body.refreshToken).toBeTruthy();
    expect(reg.body.user).toMatchObject({ username: 'jane', displayName: 'Jane' });
    expect(JSON.stringify(reg.body)).not.toContain('password');

    for (const identifier of ['jane', 'JANE', 'jane@example.com', 'JANE@EXAMPLE.COM']) {
      const res = await post('/auth/login', { identifier, password: credentials.password });
      expect(res.status, identifier).toBe(200);
      expect(res.body.user.id).toBe(reg.body.user.id);
    }
  });

  it('leaves email unverified for password signups', async () => {
    const reg = await register();
    const me = await get('/auth/me', reg.body.accessToken);
    expect(me.body.emailVerifiedAt).toBeNull();
  });

  it('allows registering without an email', async () => {
    const reg = await post('/auth/register', {
      username: 'noemail',
      password: 'a long password',
      displayName: 'N',
    });
    expect(reg.status).toBe(201);
    expect(reg.body.user.email).toBeNull();
  });

  it('answers bad password and unknown user identically', async () => {
    await register();
    const wrong = await post('/auth/login', { identifier: 'jane', password: 'wrong password!!' });
    const unknown = await post('/auth/login', { identifier: 'ghost', password: 'wrong password!!' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('rejects a password login for an OAuth-only user the same uniform way', async () => {
    await oauthLogin('c1', profile());
    const res = await post('/auth/login', { identifier: 'octo', password: 'whatever password' });
    expect(res.status).toBe(401);
  });

  it('rejects usernames with @, bad passwords and unknown fields', async () => {
    expect((await register({ username: 'a@b.com' })).status).toBe(400);
    expect((await register({ password: 'too short' })).status).toBe(400);
    expect((await register({ password: 'x'.repeat(257) })).status).toBe(400);
    expect((await register({ isAdmin: true })).status).toBe(400);
    const extra = { identifier: 'a', password: 'b'.repeat(12), extra: 1 };
    expect((await post('/auth/login', extra)).status).toBe(400);
  });

  it('rejects duplicate usernames and emails ignoring case', async () => {
    await register();
    expect((await register({ username: 'JANE', email: 'other@example.com' })).status).toBe(409);
    expect((await register({ username: 'other', email: 'jane@EXAMPLE.com' })).status).toBe(409);
  });
});

describe('access token', () => {
  it('serves /auth/me with a valid Bearer token', async () => {
    const reg = await register();
    const me = await get('/auth/me', reg.body.accessToken);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: reg.body.user.id, username: 'jane' });
  });

  it('rejects missing, garbage and expired tokens', async () => {
    const reg = await register();
    expect((await get('/auth/me')).status).toBe(401);
    expect((await get('/auth/me', 'garbage')).status).toBe(401);
    t.clock.advance(16 * 60_000);
    expect((await get('/auth/me', reg.body.accessToken)).status).toBe(401);
  });

  it('rejects a token for a deleted user', async () => {
    const reg = await register();
    await t.prisma.user.delete({ where: { id: reg.body.user.id } });
    expect((await get('/auth/me', reg.body.accessToken)).status).toBe(401);
  });
});

describe('refresh rotation', () => {
  it('rotates the refresh token within one family', async () => {
    const reg = await register();
    const next = await post('/auth/refresh', { refreshToken: reg.body.refreshToken });
    expect(next.status).toBe(200);
    expect(next.body.refreshToken).not.toBe(reg.body.refreshToken);
    expect((await get('/auth/me', next.body.accessToken)).status).toBe(200);
    const rows = await t.prisma.refreshToken.findMany();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
    expect(rows.some((r) => r.tokenHash === reg.body.refreshToken)).toBe(false);
  });

  it('revokes the whole family when a rotated token is presented again', async () => {
    const reg = await register();
    const next = await post('/auth/refresh', { refreshToken: reg.body.refreshToken });
    expect((await post('/auth/refresh', { refreshToken: reg.body.refreshToken })).status).toBe(401);
    expect((await post('/auth/refresh', { refreshToken: next.body.refreshToken })).status).toBe(401);
  });

  it('does not touch other families on reuse', async () => {
    const a = await register();
    const b = await post('/auth/login', { identifier: 'jane', password: credentials.password });
    await post('/auth/refresh', { refreshToken: a.body.refreshToken });
    await post('/auth/refresh', { refreshToken: a.body.refreshToken });
    expect((await post('/auth/refresh', { refreshToken: b.body.refreshToken })).status).toBe(200);
  });

  it('rejects unknown and expired refresh tokens', async () => {
    const reg = await register();
    expect((await post('/auth/refresh', { refreshToken: 'nope'.repeat(11) })).status).toBe(401);
    t.clock.advance(31 * 24 * 3_600_000);
    expect((await post('/auth/refresh', { refreshToken: reg.body.refreshToken })).status).toBe(401);
  });

  it('logout revokes the family of the presented token', async () => {
    const reg = await register();
    const next = await post('/auth/refresh', { refreshToken: reg.body.refreshToken });
    expect((await post('/auth/logout', { refreshToken: next.body.refreshToken })).status).toBe(204);
    expect((await post('/auth/refresh', { refreshToken: next.body.refreshToken })).status).toBe(401);
    // Idempotent, and unknown tokens do not leak existence.
    expect((await post('/auth/logout', { refreshToken: next.body.refreshToken })).status).toBe(204);
    expect((await post('/auth/logout', { refreshToken: 'nope'.repeat(11) })).status).toBe(204);
  });
});

describe('oauth', () => {
  it('returns 404 for a disabled or unknown provider', async () => {
    expect((await get('/auth/oauth/google/start')).status).toBe(404);
    expect((await get('/auth/oauth/google/callback?code=a&state=b')).status).toBe(404);
    expect((await get('/auth/oauth/nope/start')).status).toBe(404);
    const reg = await register();
    const link = await post('/auth/oauth/google/link/start', {}, reg.body.accessToken);
    expect(link.status).toBe(404);
  });

  it('creates a new user from the provider profile and hands the web a cookie, not tokens', async () => {
    const cb = await oauthLogin('c1', profile());
    expect(cb.status).toBe(302);
    expect(cb.location).toBe(`${WEB}/auth/complete`);
    const cookie = cb.setCookies.find((c) => c.startsWith('oc_refresh='));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    // No token or secret may travel in the redirect URL or the body.
    expect(cb.location).not.toContain(refreshPair(cb).split('=')[1]);
    expect(JSON.stringify(cb.body)).not.toContain(refreshPair(cb).split('=')[1]);

    const { user } = await oauthUser('c2', profile());
    expect(user).toMatchObject({ username: 'octo', displayName: 'Octo Cat', email: 'octo@example.com' });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await t.prisma.oAuthIdentity.count()).toBe(1);
  });

  it('sends a PKCE challenge whose verifier is used on exchange', async () => {
    await oauthLogin('c1', profile());
    const auth = t.github.lastAuthorization!;
    expect(auth.redirectUri).toBe('http://api.test/auth/oauth/github/callback');
    expect(s256(t.github.lastExchange!.codeVerifier)).toBe(auth.codeChallenge);
  });

  it('logs in the same user on a later login with the same identity', async () => {
    const first = await oauthUser('c1', profile());
    const second = await oauthUser('c2', profile({ displayName: 'Changed' }));
    expect(second.user.id).toBe(first.user.id);
    expect(await t.prisma.user.count()).toBe(1);
  });

  it('de-duplicates generated usernames', async () => {
    await post('/auth/register', { username: 'octo', password: 'a long password', displayName: 'X' });
    const res = await oauthUser('c1', profile({ login: 'octo' }));
    expect(res.user.username).toMatch(/^octo-[a-z0-9]{6}$/);
  });

  it('never auto-links by email: a taken email yields a new user with no email', async () => {
    const existing = await register({ email: 'octo@example.com', username: 'someone' });
    const res = await oauthUser('c1', profile({ email: 'octo@example.com' }));
    expect(res.user.id).not.toBe(existing.body.user.id);
    expect(res.user.email).toBeNull();
    expect(res.user.emailVerifiedAt).toBeNull();
    const linked = await t.prisma.oAuthIdentity.count({ where: { userId: existing.body.user.id } });
    expect(linked).toBe(0);
  });

  it('keeps the email out when the provider does not verify it', async () => {
    const res = await oauthUser('c1', profile({ emailVerified: false }));
    expect(res.user.email).toBeNull();
  });

  it('rejects invalid state, provider errors, bad codes and expired state', async () => {
    t.github.profiles.set('c1', profile());
    expect((await get('/auth/oauth/github/callback?code=c1&state=garbage')).status).toBe(400);
    expect((await get('/auth/oauth/github/callback?code=c1')).status).toBe(400);
    const start = await get('/auth/oauth/github/start');
    const state = stateFrom(start.location);
    const cookie = cookieOf(start);
    // With a verified web state, failures bounce to the web app with a short code (never a token).
    const denied = await get(`/auth/oauth/github/callback?error=access_denied&state=${state}`, undefined, cookie);
    expect(denied.status).toBe(302);
    expect(denied.location).toBe(`${WEB}/login?error=access_denied`);
    const unknown = await get(`/auth/oauth/github/callback?code=unknown&state=${state}`, undefined, cookie);
    expect(unknown.status).toBe(302);
    expect(unknown.location).toBe(`${WEB}/login?error=failed`);
    t.clock.advance(11 * 60_000);
    expect((await get(`/auth/oauth/github/callback?code=c1&state=${state}`, undefined, cookie)).status).toBe(400);
  });

  describe('browser binding', () => {
    const cbPath = (code: string, start: Res) =>
      `/auth/oauth/github/callback?code=${code}&state=${encodeURIComponent(stateFrom(start.location))}`;

    it('sets a hardened, path-scoped cookie when a flow starts', async () => {
      const start = await get('/auth/oauth/github/start');
      for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/auth/oauth', 'Max-Age=600']) {
        expect(start.setCookie).toContain(attr);
      }
      expect(start.setCookie).not.toContain('Secure'); // the test base URL is http
    });

    it('bounces to the web app with a generic code when the provider is unavailable', async () => {
      t.github.failWith = new ProviderUnavailableError();
      try {
        const start = await get('/auth/oauth/github/start');
        const cb = await get(cbPath('c1', start), undefined, cookieOf(start));
        expect(cb.status).toBe(302);
        expect(cb.location).toBe(`${WEB}/login?error=provider_unavailable`);
        expect(cb.location).not.toContain('c1');
      } finally {
        t.github.failWith = undefined;
      }
    });

    it('keeps two simultaneous flows in one browser apart (one cookie per flow)', async () => {
      t.github.profiles.set('c1', profile());
      t.github.profiles.set('c2', profile({ providerUserId: 'gh-2', login: 'second' }));
      const first = await get('/auth/oauth/github/start');
      const second = await get('/auth/oauth/github/start');
      const firstCookie = cookieOf(first);
      const secondCookie = cookieOf(second);
      expect(firstCookie.split('=')[0]).not.toBe(secondCookie.split('=')[0]);
      const jar = [firstCookie, secondCookie].join('; ');
      expect((await get(cbPath('c1', first), undefined, jar)).location).toBe(`${WEB}/auth/complete`);
      const done = await get(cbPath('c2', second), undefined, jar);
      expect(done.location).toBe(`${WEB}/auth/complete`);
      // Each callback expires its own flow's cookie, not the other's.
      expect(done.setCookie).toContain(`${secondCookie.split('=')[0]}=;`);
    });

    it('rejects a callback without the cookie', async () => {
      t.github.profiles.set('c1', profile());
      const start = await get('/auth/oauth/github/start');
      const cb = await get(cbPath('c1', start));
      expect(cb.location).toBe(`${WEB}/login?error=invalid_state`);
      expect(cb.setCookies.some((c) => c.startsWith('oc_refresh='))).toBe(false);
      expect(await t.prisma.user.count()).toBe(0);
    });

    it('rejects a cookie that belongs to a different flow', async () => {
      t.github.profiles.set('c1', profile());
      const start = await get('/auth/oauth/github/start');
      const other = await get('/auth/oauth/github/start');
      const cb = await get(cbPath('c1', start), undefined, cookieOf(other));
      expect(cb.location).toBe(`${WEB}/login?error=invalid_state`);
      expect(await t.prisma.user.count()).toBe(0);
    });

    it('clears the binding cookie on the callback (next to the refresh cookie)', async () => {
      t.github.profiles.set('c1', profile());
      const start = await get('/auth/oauth/github/start');
      const cb = await get(cbPath('c1', start), undefined, cookieOf(start));
      expect(cb.status).toBe(302);
      expect(cb.setCookies.some((c) => c.startsWith('oc_oauth_') && c.includes('Max-Age=0'))).toBe(true);
      expect(cb.setCookies.some((c) => c.startsWith('oc_refresh='))).toBe(true);
    });

    it('does not link when the victim browser lacks the attacker cookie', async () => {
      const attacker = await register();
      const start = await post('/auth/oauth/github/link/start', {}, attacker.body.accessToken);
      expect(start.setCookie).toContain('HttpOnly');
      t.github.profiles.set('victim', profile({ providerUserId: 'victim-gh' }));
      const victim = await get(
        `/auth/oauth/github/callback?code=victim&state=${encodeURIComponent(stateFrom(start.body.url))}`,
      );
      expect(victim.location).toBe(`${WEB}/account?error=invalid_state`);
      expect(await t.prisma.oAuthIdentity.count()).toBe(0);
    });
  });

  describe('linking', () => {
    const callback = (code: string, url: string, cookie?: string) =>
      get(
        `/auth/oauth/github/callback?code=${code}&state=${encodeURIComponent(stateFrom(url))}`,
        undefined,
        cookie,
      );

    it('requires authentication', async () => {
      expect((await post('/auth/oauth/github/link/start')).status).toBe(401);
    });

    it('links a provider to the current user, then that identity logs in as them', async () => {
      const reg = await register();
      const start = await post('/auth/oauth/github/link/start', {}, reg.body.accessToken);
      expect(start.status).toBe(200);
      t.github.profiles.set('c1', profile());
      const cb = await callback('c1', start.body.url, cookieOf(start));
      expect(cb.status).toBe(302);
      expect(cb.location).toBe(`${WEB}/account?linked=github`);
      // Linking never opens a session: no refresh cookie.
      expect(cb.setCookies.some((c) => c.startsWith('oc_refresh='))).toBe(false);

      const login = await oauthUser('c2', profile());
      expect(login.user.id).toBe(reg.body.user.id);
      expect(await t.prisma.user.count()).toBe(1);
    });

    it('refuses to link an identity that belongs to another user', async () => {
      await oauthLogin('c1', profile());
      const reg = await register();
      const start = await post('/auth/oauth/github/link/start', {}, reg.body.accessToken);
      t.github.profiles.set('c2', profile());
      const cb = await callback('c2', start.body.url, cookieOf(start));
      expect(cb.location).toBe(`${WEB}/account?error=conflict`);
    });

    it('refuses a second identity of the same provider for one user', async () => {
      const reg = await register();
      const cases = [
        ['c1', 'gh-1', `${WEB}/account?linked=github`],
        ['c2', 'gh-2', `${WEB}/account?error=conflict`],
      ] as const;
      for (const [code, id, expected] of cases) {
        const start = await post('/auth/oauth/github/link/start', {}, reg.body.accessToken);
        t.github.profiles.set(code, profile({ providerUserId: id }));
        expect((await callback(code, start.body.url, cookieOf(start))).location).toBe(expected);
      }
    });
  });
});

describe('desktop flow', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = s256(verifier);

  async function desktopCode(code = 'c1'): Promise<string> {
    const res = await oauthLogin(code, profile(), `?client=desktop&code_challenge=${challenge}`);
    expect(res.status).toBe(302);
    const url = new URL(res.location as string);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('opencollab://auth/callback');
    return url.searchParams.get('code') as string;
  }

  it('requires a valid code_challenge and client to start', async () => {
    expect((await get('/auth/oauth/github/start?client=desktop')).status).toBe(400);
    expect((await get('/auth/oauth/github/start?client=desktop&code_challenge=short')).status).toBe(400);
    expect((await get('/auth/oauth/github/start?client=other')).status).toBe(400);
  });

  it('exchanges the code with the right verifier for tokens', async () => {
    const code = await desktopCode();
    const res = await post('/auth/desktop/token', { code, codeVerifier: verifier });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('octo');
    expect((await get('/auth/me', res.body.accessToken)).status).toBe(200);
    const row = await t.prisma.desktopLoginCode.findFirstOrThrow();
    expect(row.codeHash).not.toBe(code);
  });

  it('rejects a wrong verifier and burns the code', async () => {
    const code = await desktopCode();
    const wrong = await post('/auth/desktop/token', { code, codeVerifier: `${verifier}x` });
    expect(wrong.status).toBe(400);
    expect((await post('/auth/desktop/token', { code, codeVerifier: verifier })).status).toBe(400);
  });

  it('rejects an expired code', async () => {
    const code = await desktopCode();
    t.clock.advance(61_000);
    expect((await post('/auth/desktop/token', { code, codeVerifier: verifier })).status).toBe(400);
  });

  it('rejects a reused code and unknown codes', async () => {
    const code = await desktopCode();
    expect((await post('/auth/desktop/token', { code, codeVerifier: verifier })).status).toBe(200);
    expect((await post('/auth/desktop/token', { code, codeVerifier: verifier })).status).toBe(400);
    expect((await post('/auth/desktop/token', { code: 'nope', codeVerifier: verifier })).status).toBe(400);
  });
});

describe('web session (cookie)', () => {
  const login = () =>
    webPost('/auth/web/login', { identifier: 'jane', password: credentials.password });
  const webRegister = () => webPost('/auth/web/register', { ...credentials, displayName: 'Jane' });

  it('registers and logs in with the refresh token in a hardened cookie and only the access token in JSON', async () => {
    const reg = await webRegister();
    expect(reg.status).toBe(201);
    expect(reg.body.user).toMatchObject({ username: 'jane' });
    expect(reg.body.refreshToken).toBeUndefined();
    expect(reg.body.accessToken).toBeTruthy();
    for (const attr of ['HttpOnly', 'SameSite=Strict', 'Path=/auth', `Max-Age=${30 * 24 * 3600}`]) {
      expect(reg.setCookies.find((c) => c.startsWith('oc_refresh='))).toContain(attr);
    }
    expect((await get('/auth/me', reg.body.accessToken)).status).toBe(200);

    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBeUndefined();
    expect(res.body.user.id).toBe(reg.body.user.id);
    expect(refreshPair(res)).toMatch(/^oc_refresh=.+/);
  });

  it('keeps the JSON-token routes (desktop) untouched', async () => {
    const reg = await register();
    expect(reg.body.refreshToken).toBeTruthy();
    expect(reg.setCookies).toEqual([]);
  });

  it('answers bad credentials with 401 and no cookie', async () => {
    await webRegister();
    const res = await webPost('/auth/web/login', { identifier: 'jane', password: 'wrong password!!' });
    expect(res.status).toBe(401);
    expect(res.setCookies).toEqual([]);
  });

  it('rotates through the cookie and re-sets it', async () => {
    const reg = await webRegister();
    const first = refreshPair(reg);
    const next = await webPost('/auth/web/refresh', undefined, first);
    expect(next.status).toBe(200);
    expect(next.body.refreshToken).toBeUndefined();
    expect(next.body).toMatchObject({ tokenType: 'Bearer' });
    expect(refreshPair(next)).not.toBe(first);
    expect((await get('/auth/me', next.body.accessToken)).status).toBe(200);
  });

  it('keeps reuse detection: a spent cookie revokes the family and is cleared', async () => {
    const reg = await webRegister();
    const first = refreshPair(reg);
    const next = await webPost('/auth/web/refresh', undefined, first);
    t.clock.advance(10_000); // past the second-tab grace window
    const reuse = await webPost('/auth/web/refresh', undefined, first);
    expect(reuse.status).toBe(401);
    expect(reuse.setCookies.find((c) => c.startsWith('oc_refresh='))).toContain('Max-Age=0');
    expect((await webPost('/auth/web/refresh', undefined, refreshPair(next))).status).toBe(401);
  });

  describe('refresh grace window (second tab)', () => {
    const rotateOnce = async () => {
      const reg = await webRegister();
      const first = refreshPair(reg);
      const winner = await webPost('/auth/web/refresh', undefined, first);
      return { reg, first, winner };
    };
    const sid = (token: string): string =>
      JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).sid;

    it('answers a token rotated seconds ago with only an access token of the same family, no cookie', async () => {
      const { reg, first, winner } = await rotateOnce();
      t.clock.advance(5_000);
      const replay = await webPost('/auth/web/refresh', undefined, first);
      expect(replay.status).toBe(200);
      expect(replay.setCookies).toEqual([]);
      expect(Object.keys(replay.body).sort()).toEqual(['accessToken', 'expiresIn', 'tokenType']);
      expect((await get('/auth/me', replay.body.accessToken)).status).toBe(200);
      expect(sid(replay.body.accessToken)).toBe(sid(reg.body.accessToken));
      // The winner's successor is intact and keeps rotating.
      expect((await webPost('/auth/web/refresh', undefined, refreshPair(winner))).status).toBe(200);
    });

    it('past the window it is reuse: 401, cookie cleared, family revoked', async () => {
      const { first, winner } = await rotateOnce();
      t.clock.advance(10_000);
      const reuse = await webPost('/auth/web/refresh', undefined, first);
      expect(reuse.status).toBe(401);
      expect(reuse.setCookies.find((c) => c.startsWith('oc_refresh='))).toContain('Max-Age=0');
      expect((await webPost('/auth/web/refresh', undefined, refreshPair(winner))).status).toBe(401);
    });

    it('does not apply to the JSON route (desktop): a replay revokes the family at once', async () => {
      const reg = await register();
      const first = reg.body.refreshToken;
      const next = await post('/auth/refresh', { refreshToken: first });
      expect((await post('/auth/refresh', { refreshToken: first })).status).toBe(401);
      expect((await post('/auth/refresh', { refreshToken: next.body.refreshToken })).status).toBe(401);
    });
  });

  it('rejects a missing cookie with 401', async () => {
    expect((await webPost('/auth/web/refresh')).status).toBe(401);
  });

  it('logs out: revokes the family and clears the cookie (idempotent)', async () => {
    const reg = await webRegister();
    const cookie = refreshPair(reg);
    const out = await webPost('/auth/web/logout', undefined, cookie);
    expect(out.status).toBe(204);
    expect(out.setCookies.find((c) => c.startsWith('oc_refresh='))).toContain('Max-Age=0');
    expect((await webPost('/auth/web/refresh', undefined, cookie)).status).toBe(401);
    expect((await webPost('/auth/web/logout', undefined, cookie)).status).toBe(204);
    expect((await webPost('/auth/web/logout')).status).toBe(204);
  });

  describe('CSRF header', () => {
    it('is required on every web route: 403 without it, and nothing happens', async () => {
      const reg = await webRegister();
      const cookie = refreshPair(reg);
      const cases: Array<[string, unknown]> = [
        ['/auth/web/login', { identifier: 'jane', password: credentials.password }],
        ['/auth/web/register', { ...credentials, username: 'other', email: 'o@example.com' }],
        ['/auth/web/refresh', undefined],
        ['/auth/web/logout', undefined],
      ];
      for (const [path, body] of cases) {
        for (const headers of [{}, { 'X-OpenCollab-CSRF': '0' }] as Array<Record<string, string>>) {
          const res = await webPost(path, body, cookie, headers);
          expect(res.status, path).toBe(403);
          expect(res.setCookies, path).toEqual([]);
        }
      }
      expect(await t.prisma.user.count()).toBe(1);
      // The cookie was neither rotated nor revoked by the rejected calls.
      expect((await webPost('/auth/web/refresh', undefined, cookie)).status).toBe(200);
    });
  });
});

describe('desktop code from a web session', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = s256(verifier);
  const PATH = '/auth/web/desktop-code';
  const webRegister = () => webPost('/auth/web/register', { ...credentials, displayName: 'Jane' });

  it('rejects a bearer access token alone: a stolen access token cannot mint a code', async () => {
    const reg = await webRegister();
    const token = reg.body.accessToken;
    expect((await call('POST', PATH, { code_challenge: challenge }, token, undefined, CSRF)).status).toBe(401);
    expect((await post(PATH, { code_challenge: challenge }, token)).status).toBe(403);
    expect((await post('/auth/desktop/code', { code_challenge: challenge }, token)).status).toBe(404);
  });

  it('needs the CSRF header and a live cookie', async () => {
    const cookie = refreshPair(await webRegister());
    expect((await webPost(PATH, { code_challenge: challenge }, cookie, {})).status).toBe(403);
    expect((await webPost(PATH, { code_challenge: challenge })).status).toBe(401);
    await webPost('/auth/web/logout', undefined, cookie);
    expect((await webPost(PATH, { code_challenge: challenge }, cookie)).status).toBe(401);
  });

  it('issues a code from the cookie without rotating it, and the unchanged exchange accepts it', async () => {
    const reg = await webRegister();
    const cookie = refreshPair(reg);
    const res = await webPost(PATH, { code_challenge: challenge }, cookie);
    expect(res.status).toBe(200);
    expect(res.setCookies).toEqual([]);
    const url = new URL(res.body.redirectUrl);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('opencollab://auth/callback');
    const tokens = await post('/auth/desktop/token', {
      code: url.searchParams.get('code'),
      codeVerifier: verifier,
    });
    expect(tokens.status).toBe(200);
    expect(tokens.body.user.id).toBe(reg.body.user.id);
    // A different session (new family): it is a fresh login, not the web one.
    expect(tokens.body.refreshToken).toBeTruthy();
    // The web cookie was only read: it still rotates.
    expect((await webPost('/auth/web/refresh', undefined, cookie)).status).toBe(200);
  });

  it('validates the challenge, rejects unknown fields and burns the code on a wrong verifier', async () => {
    const cookie = refreshPair(await webRegister());
    expect((await webPost(PATH, {}, cookie)).status).toBe(400);
    expect((await webPost(PATH, { code_challenge: 'short' }, cookie)).status).toBe(400);
    expect((await webPost(PATH, { code_challenge: challenge, x: 1 }, cookie)).status).toBe(400);
    const res = await webPost(PATH, { code_challenge: challenge }, cookie);
    const code = new URL(res.body.redirectUrl).searchParams.get('code');
    expect((await post('/auth/desktop/token', { code, codeVerifier: `${verifier}x` })).status).toBe(400);
    expect((await post('/auth/desktop/token', { code, codeVerifier: verifier })).status).toBe(400);
  });

  it('is throttled like the other auth routes', async () => {
    const limited = await startTestApp({ rateLimitEnabled: true });
    try {
      let last = 0;
      for (let i = 0; i < 12; i += 1) {
        const res = await fetch(`${limited.baseUrl}/auth/web/desktop-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...CSRF },
          body: JSON.stringify({ code_challenge: challenge }),
        });
        last = res.status;
      }
      expect(last).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe('rate limiting', () => {
  it('answers 429 after too many login attempts', async () => {
    const limited = await startTestApp({ rateLimitEnabled: true });
    try {
      let last = 0;
      for (let i = 0; i < 12; i += 1) {
        const res = await fetch(`${limited.baseUrl}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: 'x', password: 'y'.repeat(12) }),
        });
        last = res.status;
      }
      expect(last).toBe(429);
    } finally {
      await limited.close();
    }
  });

  describe('behind a reverse proxy', () => {
    const loginFrom = (baseUrl: string, ip: string): Promise<number> =>
      fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
        body: JSON.stringify({ identifier: 'x', password: 'y'.repeat(12) }),
      }).then((res) => res.status);

    it('throttles per forwarded client IP when TRUST_PROXY trusts the hop', async () => {
      const limited = await startTestApp({ rateLimitEnabled: true, trustProxy: 1 });
      try {
        for (let i = 0; i < 10; i += 1) await loginFrom(limited.baseUrl, '203.0.113.1');
        expect(await loginFrom(limited.baseUrl, '203.0.113.1')).toBe(429);
        expect(await loginFrom(limited.baseUrl, '203.0.113.2')).toBe(401);
      } finally {
        await limited.close();
      }
    });

    it('ignores X-Forwarded-For by default, so a client cannot dodge the limit by spoofing it', async () => {
      const limited = await startTestApp({ rateLimitEnabled: true });
      try {
        for (let i = 0; i < 10; i += 1) await loginFrom(limited.baseUrl, `203.0.113.${i}`);
        expect(await loginFrom(limited.baseUrl, '203.0.113.99')).toBe(429);
      } finally {
        await limited.close();
      }
    });
  });
});
