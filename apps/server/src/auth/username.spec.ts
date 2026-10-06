import { describe, expect, it } from 'vitest';

import { isValidUsername, pickAvailableUsername, sanitizeUsername } from './username';

describe('isValidUsername', () => {
  it('accepts 3-32 chars of letters, digits, underscore and hyphen', () => {
    expect(isValidUsername('abc')).toBe(true);
    expect(isValidUsername('Fa_cu-99')).toBe(true);
    expect(isValidUsername('a'.repeat(32))).toBe(true);
  });

  it('rejects @, spaces, dots and bad lengths', () => {
    expect(isValidUsername('a@b.com')).toBe(false);
    expect(isValidUsername('ab')).toBe(false);
    expect(isValidUsername('a'.repeat(33))).toBe(false);
    expect(isValidUsername('with space')).toBe(false);
    expect(isValidUsername('dot.name')).toBe(false);
  });
});

describe('sanitizeUsername', () => {
  it('replaces invalid characters and always yields a valid username', () => {
    for (const raw of ['Jane Doe', 'jane.doe', '日本語', '', '  ', '@@', 'a', 'x'.repeat(80)]) {
      expect(isValidUsername(sanitizeUsername(raw))).toBe(true);
    }
    expect(sanitizeUsername('jane.doe')).toBe('jane-doe');
  });
});

describe('pickAvailableUsername', () => {
  it('returns the base when free', async () => {
    expect(await pickAvailableUsername('jane', async () => false)).toBe('jane');
  });

  it('appends a numeric suffix until free', async () => {
    const taken = new Set(['jane', 'jane2', 'jane3']);
    expect(await pickAvailableUsername('jane', async (u) => taken.has(u))).toBe('jane4');
  });

  it('keeps the result within 32 chars when suffixing', async () => {
    const base = 'x'.repeat(32);
    const result = await pickAvailableUsername(base, async (u) => u === base);
    expect(result).toHaveLength(32);
    expect(isValidUsername(result)).toBe(true);
    expect(result).not.toBe(base);
  });
});
