import { describe, expect, it } from 'vitest';

import { generateToken, hashToken, isValidCodeChallenge, s256, verifyPkceS256 } from './tokens';

describe('tokens', () => {
  it('generates distinct url-safe tokens of at least 32 bytes', () => {
    const a = generateToken();
    expect(a).not.toBe(generateToken());
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(a, 'base64url').length).toBeGreaterThanOrEqual(32);
  });

  it('hashes deterministically to hex SHA-256 without keeping the input', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('PKCE S256', () => {
  // RFC 7636 appendix B.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  it('derives the RFC 7636 challenge', () => {
    expect(s256(verifier)).toBe(challenge);
  });

  it('accepts the matching verifier and rejects others', () => {
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256(`${verifier}x`, challenge)).toBe(false);
    expect(verifyPkceS256('', challenge)).toBe(false);
  });

  it('validates the challenge shape (43 base64url chars)', () => {
    expect(isValidCodeChallenge(challenge)).toBe(true);
    expect(isValidCodeChallenge('short')).toBe(false);
    expect(isValidCodeChallenge(`${challenge}=`)).toBe(false);
  });
});
