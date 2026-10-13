import { expect } from 'vitest';

import { DomainError, type DomainErrorInfo } from './error';

// Asserts that `fn` throws a DomainError with exactly this payload.
export function expectDomainError(fn: () => unknown, info: DomainErrorInfo): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(DomainError);
  expect((thrown as DomainError).info).toEqual(info);
}
