import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionDeadline, TOKEN_GRACE_MS } from './connection-deadline';

describe('ConnectionDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  it('fires once the token expiry plus the grace has passed', () => {
    const expired = vi.fn();
    new ConnectionDeadline(expired).set(nowSeconds() + 60);
    vi.advanceTimersByTime(60_000 + TOKEN_GRACE_MS - 1);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledOnce();
  });

  it('moves the deadline when set again', () => {
    const expired = vi.fn();
    const deadline = new ConnectionDeadline(expired);
    deadline.set(nowSeconds() + 60);
    deadline.set(nowSeconds() + 600);
    vi.advanceTimersByTime(60_000 + TOKEN_GRACE_MS);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(540_000);
    expect(expired).toHaveBeenCalledOnce();
  });

  it('fires right away for a token that already expired beyond the grace', () => {
    const expired = vi.fn();
    new ConnectionDeadline(expired).set(nowSeconds() - 60);
    vi.advanceTimersByTime(0);
    expect(expired).toHaveBeenCalledOnce();
  });

  it('never fires after clear and leaves no pending timer', () => {
    const expired = vi.fn();
    const deadline = new ConnectionDeadline(expired);
    deadline.set(nowSeconds() + 1);
    deadline.clear();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(expired).not.toHaveBeenCalled();
  });
});
