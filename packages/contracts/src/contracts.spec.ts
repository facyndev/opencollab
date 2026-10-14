import { describe, expect, it } from 'vitest';

import { INCOMPATIBLE_PROTOCOL_VERSION, INVALID_MESSAGE, PROTOCOL_VERSION, parseFrame } from './index';

/** The raw error a frame would be answered with, or undefined when it is accepted. */
function replyForTextFrame(text: string): string | undefined {
  const parsed = parseFrame(text);
  return parsed.ok ? undefined : parsed.error;
}

// Wire parity with `crates/protocol` and the former `server/src/protocol.ts`:
// same fixtures, same expectations (snake_case, Vec<u8> as number[],
// version u16, rejection of 1.0/1e0 like serde).
describe('contracts wire', () => {
  it('exposes PROTOCOL_VERSION 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('accepts a valid frame and hands back the parsed message', () => {
    const message = { type: 'access_changed', session_id: 's', user_id: 'u', access: 'view' };
    expect(parseFrame(JSON.stringify({ version: 1, message }))).toEqual({
      ok: true,
      envelope: { version: 1, message },
    });
  });

  it('rejects other versions (mirror of the Rust envelope test)', () => {
    const text =
      '{"version":999,"message":{"type":"terminal_output","session_id":"s","terminal_id":"t","data":[104,105]}}';
    expect(replyForTextFrame(text)).toBe(INCOMPATIBLE_PROTOCOL_VERSION);
  });

  it('rejects valid JSON that is not an envelope as an invalid message', () => {
    expect(replyForTextFrame('{"version":1}')).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame('{"version":1,"message":{"type":"unknown"}}')).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame('esto no es json {')).toBe(INVALID_MESSAGE);
  });

  it('rejects non-integer numbers the way serde rejects them', () => {
    const message = '{"type":"access_changed","session_id":"s","user_id":"u","access":"none"}';
    expect(replyForTextFrame(`{"version":1.0,"message":${message}}`)).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame(`{"version":1e0,"message":${message}}`)).toBe(INVALID_MESSAGE);
    const output = (data: string) =>
      `{"version":1,"message":{"type":"terminal_output","session_id":"s","terminal_id":"t","data":${data}}}`;
    expect(replyForTextFrame(output('[1.5]'))).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame(output('[104,256]'))).toBe(INVALID_MESSAGE);
  });

  it('accepts the known access levels and rejects the rest', () => {
    const frame = (access: string) =>
      `{"version":1,"message":{"type":"joined","session_id":"s","access":${access}}}`;
    expect(replyForTextFrame(frame('"write"'))).toBeUndefined();
    expect(replyForTextFrame(frame('"root"'))).toBe(INVALID_MESSAGE);
  });
});
