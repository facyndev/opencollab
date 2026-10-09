import { describe, expect, it } from 'vitest';

import { STATE_TTL_SECONDS, pkceVerifierFor, signState, verifyState, type OAuthState } from './state';

const secret = 'test-secret-test-secret-test-secret-1234';
const now = new Date('2026-01-01T00:00:00Z');
const payload: OAuthState = {
  provider: 'github',
  intent: 'login',
  client: 'web',
  nonce: 'n-1',
  flow: 'f-1',
  binding: 'b-1',
};

describe('oauth state', () => {
  it('round-trips the payload', () => {
    expect(verifyState(signState(payload, secret, now), secret, now)).toEqual(payload);
  });

  it('rejects a tampered token', () => {
    const [h, p, s] = signState(payload, secret, now).split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, intent: 'link', linkUserId: 'x' }))
      .toString('base64url');
    expect(verifyState(`${h}.${forged}.${s}`, secret, now)).toBeUndefined();
    expect(verifyState(`${h}.${p}.${s}x`, secret, now)).toBeUndefined();
  });

  it('rejects another secret and garbage', () => {
    expect(verifyState(signState(payload, secret, now), `${secret}!`, now)).toBeUndefined();
    expect(verifyState('garbage', secret, now)).toBeUndefined();
  });

  it('rejects a state without a flow id', () => {
    const { flow: _flow, ...legacy } = payload;
    expect(verifyState(signState(legacy as OAuthState, secret, now), secret, now)).toBeUndefined();
  });

  it('expires after STATE_TTL_SECONDS (10 minutes)', () => {
    expect(STATE_TTL_SECONDS).toBe(600);
    const token = signState(payload, secret, now);
    expect(verifyState(token, secret, new Date(now.getTime() + 9 * 60_000))).toEqual(payload);
    expect(verifyState(token, secret, new Date(now.getTime() + 11 * 60_000))).toBeUndefined();
  });
});

describe('pkceVerifierFor', () => {
  it('is deterministic per nonce, valid length and secret-dependent', () => {
    const v = pkceVerifierFor(secret, 'n-1');
    expect(v).toBe(pkceVerifierFor(secret, 'n-1'));
    expect(v).not.toBe(pkceVerifierFor(secret, 'n-2'));
    expect(v).not.toBe(pkceVerifierFor(`${secret}!`, 'n-1'));
    expect(v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });
});
