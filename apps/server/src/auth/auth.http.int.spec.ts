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
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  cookie?: string,
): Promise<Res> {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
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
  };
}

const post = (path: string, body?: unknown, token?: string) => call('POST', path, body ?? {}, token);
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

  it('creates a new user from the provider profile (web tokens as JSON)', async () => {
    const res = await oauthLogin('c1', profile());
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      username: 'octo',
      displayName: 'Octo Cat',
      email: 'octo@example.com',
    });
    const me = await get('/auth/me', res.body.accessToken);
    expect(me.body.emailVerifiedAt).not.toBeNull();
    expect(await t.prisma.oAuthIdentity.count()).toBe(1);
  });

  it('sends a PKCE challenge whose verifier is used on exchange', async () => {
    await oauthLogin('c1', profile());
    const auth = t.github.lastAuthorization!;
    expect(auth.redirectUri).toBe('http://api.test/auth/oauth/github/callback');
    expect(s256(t.github.lastExchange!.codeVerifier)).toBe(auth.codeChallenge);
  });

  it('logs in the same user on a later login with the same identity', async () => {
    const first = await oauthLogin('c1', profile());
    const second = await oauthLogin('c2', profile({ displayName: 'Changed' }));
    expect(second.body.user.id).toBe(first.body.user.id);
    expect(await t.prisma.user.count()).toBe(1);
  });

  it('de-duplicates generated usernames', async () => {
    await post('/auth/register', { username: 'octo', password: 'a long password', displayName: 'X' });
    const res = await oauthLogin('c1', profile({ login: 'octo' }));
    expect(res.body.user.username).toBe('octo2');
  });

  it('never auto-links by email: a taken email yields a new user with no email', async () => {
    const existing = await register({ email: 'octo@example.com', username: 'someone' });
    const res = await oauthLogin('c1', profile({ email: 'octo@example.com' }));
    expect(res.body.user.id).not.toBe(existing.body.user.id);
    expect(res.body.user.email).toBeNull();
    const me = await get('/auth/me', res.body.accessToken);
    expect(me.body.emailVerifiedAt).toBeNull();
    const linked = await t.prisma.oAuthIdentity.count({ where: { userId: existing.body.user.id } });
    expect(linked).toBe(0);
  });

  it('keeps the email out when the provider does not verify it', async () => {
    const res = await oauthLogin('c1', profile({ emailVerified: false }));
    expect(res.body.user.email).toBeNull();
  });

  it('rejects invalid state, provider errors, bad codes and expired state', async () => {
    t.github.profiles.set('c1', profile());
    expect((await get('/auth/oauth/github/callback?code=c1&state=garbage')).status).toBe(400);
    expect((await get('/auth/oauth/github/callback?code=c1')).status).toBe(400);
    const start = await get('/auth/oauth/github/start');
    const state = stateFrom(start.location);
    const cookie = cookieOf(start);
    const denied = await get(`/auth/oauth/github/callback?error=access_denied&state=${state}`, undefined, cookie);
    expect(denied.status).toBe(400);
    expect((await get(`/auth/oauth/github/callback?code=unknown&state=${state}`, undefined, cookie)).status).toBe(400);
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

    it('answers 502 with a generic message when the provider is unavailable', async () => {
      t.github.failWith = new ProviderUnavailableError();
      try {
        const start = await get('/auth/oauth/github/start');
        const cb = await get(cbPath('c1', start), undefined, cookieOf(start));
        expect(cb.status).toBe(502);
        expect(JSON.stringify(cb.body)).not.toContain('c1');
      } finally {
        t.github.failWith = undefined;
      }
    });

    it('rejects a callback without the cookie', async () => {
      t.github.profiles.set('c1', profile());
      const start = await get('/auth/oauth/github/start');
      expect((await get(cbPath('c1', start))).status).toBe(400);
      expect(await t.prisma.user.count()).toBe(0);
    });

    it('rejects a cookie that belongs to a different flow', async () => {
      t.github.profiles.set('c1', profile());
      const start = await get('/auth/oauth/github/start');
      const other = await get('/auth/oauth/github/start');
      expect((await get(cbPath('c1', start), undefined, cookieOf(other))).status).toBe(400);
      expect(await t.prisma.user.count()).toBe(0);
    });

    it('clears the cookie on the callback', async () => {
      t.github.profiles.set('c1', profile());
      const start = await get('/auth/oauth/github/start');
      const cb = await get(cbPath('c1', start), undefined, cookieOf(start));
      expect(cb.status).toBe(200);
      expect(cb.setCookie).toContain('Max-Age=0');
    });

    it('does not link when the victim browser lacks the attacker cookie', async () => {
      const attacker = await register();
      const start = await post('/auth/oauth/github/link/start', {}, attacker.body.accessToken);
      expect(start.setCookie).toContain('HttpOnly');
      t.github.profiles.set('victim', profile({ providerUserId: 'victim-gh' }));
      const victim = await get(
        `/auth/oauth/github/callback?code=victim&state=${encodeURIComponent(stateFrom(start.body.url))}`,
      );
      expect(victim.status).toBe(400);
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
      expect(cb.status).toBe(200);
      expect(cb.body).toEqual({ linked: true, provider: 'github' });

      const login = await oauthLogin('c2', profile());
      expect(login.body.user.id).toBe(reg.body.user.id);
      expect(await t.prisma.user.count()).toBe(1);
    });

    it('refuses to link an identity that belongs to another user', async () => {
      await oauthLogin('c1', profile());
      const reg = await register();
      const start = await post('/auth/oauth/github/link/start', {}, reg.body.accessToken);
      t.github.profiles.set('c2', profile());
      expect((await callback('c2', start.body.url, cookieOf(start))).status).toBe(409);
    });

    it('refuses a second identity of the same provider for one user', async () => {
      const reg = await register();
      const cases = [
        ['c1', 'gh-1', 200],
        ['c2', 'gh-2', 409],
      ] as const;
      for (const [code, id, expected] of cases) {
        const start = await post('/auth/oauth/github/link/start', {}, reg.body.accessToken);
        t.github.profiles.set(code, profile({ providerUserId: id }));
        expect((await callback(code, start.body.url, cookieOf(start))).status).toBe(expected);
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
});
