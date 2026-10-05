import { describe, expect, it } from 'vitest';

import {
  INCOMPATIBLE_PROTOCOL_VERSION,
  INVALID_MESSAGE,
  replyForTextFrame,
} from './protocol';

// Wire parity with `crates/protocol`: same fixtures, same expectations.
describe('replyForTextFrame', () => {
  it('echoes a compatible envelope byte-identically', () => {
    const text = JSON.stringify({
      version: 1,
      message: {
        type: 'access_changed',
        session_id: 's',
        user_id: 'u',
        access: 'view',
      },
    });
    expect(replyForTextFrame(text)).toBe(text);
  });

  it('rejects other versions (mirror of the Rust envelope test)', () => {
    const text =
      '{"version":999,"message":{"type":"terminal_output","session_id":"s","terminal_id":"t","data":[104,105]}}';
    expect(replyForTextFrame(text)).toBe(INCOMPATIBLE_PROTOCOL_VERSION);
  });

  it('rejects unparsable input', () => {
    expect(replyForTextFrame('esto no es json {')).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame('')).toBe(INVALID_MESSAGE);
  });

  it('rejects valid JSON that is not an envelope', () => {
    expect(replyForTextFrame('[1,2,3]')).toBe(INCOMPATIBLE_PROTOCOL_VERSION);
    expect(replyForTextFrame('null')).toBe(INCOMPATIBLE_PROTOCOL_VERSION);
    expect(replyForTextFrame('42')).toBe(INCOMPATIBLE_PROTOCOL_VERSION);
  });
});
