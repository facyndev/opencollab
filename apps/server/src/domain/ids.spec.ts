import { describe, expect, it } from 'vitest';

import { InvalidIdError } from './error';
import { newUserId, parseUserId } from './ids';

describe('ids', () => {
  it('generates distinct UUID v4 values that parse back', () => {
    const a = newUserId();
    expect(a).not.toBe(newUserId());
    expect(parseUserId(a)).toBe(a);
  });

  it('rejects a malformed id', () => {
    expect(() => parseUserId('nope')).toThrow(InvalidIdError);
  });
});
