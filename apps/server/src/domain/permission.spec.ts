import { describe, expect, it } from 'vitest';

import {
  AccessLevel,
  DEFAULT_ACCESS,
  canView,
  canWrite,
  withView,
  withWrite,
} from './permission';

const LEVELS: AccessLevel[] = ['none', 'view', 'write'];

describe('AccessLevel', () => {
  it('default is view', () => {
    expect(DEFAULT_ACCESS).toBe('view');
    expect(canView(DEFAULT_ACCESS)).toBe(true);
    expect(canWrite(DEFAULT_ACCESS)).toBe(false);
  });

  it('write without view is unrepresentable', () => {
    for (const level of LEVELS) {
      if (canWrite(level)) expect(canView(level)).toBe(true);
    }
  });

  it('enabling write enables view', () => {
    expect(withWrite('none', true)).toBe('write');
    expect(canView(withWrite('none', true))).toBe(true);
  });

  it('disabling view revokes write and access', () => {
    const level = withView('write', false);
    expect(level).toBe('none');
    expect(canView(level)).toBe(false);
    expect(canWrite(level)).toBe(false);
  });

  it('disabling write keeps view', () => {
    expect(withWrite('write', false)).toBe('view');
    expect(withWrite('none', false)).toBe('none');
  });

  it('enabling view does not downgrade write', () => {
    expect(withView('write', true)).toBe('write');
    expect(withView('none', true)).toBe('view');
  });
});
