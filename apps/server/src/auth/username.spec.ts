import { describe, expect, it } from 'vitest';

import {
  MAX_USERNAME_ATTEMPTS,
  isValidUsername,
  pickAvailableUsername,
  randomSuffix,
  sanitizeUsername,
} from './username';

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

  it('appends a random suffix, retrying when that candidate is taken too', async () => {
    const suffixes = ['aaaaaa', 'bbbbbb', 'cccccc'];
    const taken = new Set(['jane', 'jane-aaaaaa']);
    const asked: string[] = [];
    const result = await pickAvailableUsername(
      'jane',
      async (u) => (asked.push(u), taken.has(u)),
      () => suffixes.shift() as string,
    );
    expect(result).toBe('jane-bbbbbb');
    expect(asked).toEqual(['jane', 'jane-aaaaaa', 'jane-bbbbbb']);
  });

  it('does not probe linearly: two takers of the same base get different names', async () => {
    const first = await pickAvailableUsername('jane', async (u) => u === 'jane');
    const second = await pickAvailableUsername('jane', async (u) => u === 'jane');
    expect(first).toMatch(/^jane-[a-z0-9]{6}$/);
    expect(second).not.toBe(first);
  });

  it('gives up after a bounded number of attempts', async () => {
    let calls = 0;
    await expect(
      pickAvailableUsername(
        'jane',
        async () => (calls += 1, true),
        () => 'zzzzzz',
      ),
    ).rejects.toThrow(/no free username/);
    expect(calls).toBe(1 + MAX_USERNAME_ATTEMPTS);
  });

  it('generates suffixes from [a-z0-9] only', () => {
    for (let i = 0; i < 50; i += 1) expect(randomSuffix()).toMatch(/^[a-z0-9]{6}$/);
  });

  it('keeps the result within 32 chars and valid when suffixing', async () => {
    const base = 'x'.repeat(32);
    const result = await pickAvailableUsername(base, async (u) => u === base);
    expect(result).toHaveLength(32);
    expect(isValidUsername(result)).toBe(true);
    expect(result).not.toBe(base);
  });
});
