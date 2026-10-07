import { describe, expect, it } from 'vitest';

import { INCOMPATIBLE_PROTOCOL_VERSION, INVALID_MESSAGE, parseFrame } from './protocol';

/** The raw error a frame would be answered with, or undefined when it is accepted. */
function replyForTextFrame(text: string): string | undefined {
  const parsed = parseFrame(text);
  return parsed.ok ? undefined : parsed.error;
}

// Wire parity with `crates/protocol`: same fixtures, same expectations.
describe('parseFrame', () => {
  it('accepts a compatible envelope and hands back the parsed message', () => {
    const message = { type: 'access_changed', session_id: 's', user_id: 'u', access: 'view' };
    const parsed = parseFrame(JSON.stringify({ version: 1, message }));
    expect(parsed).toEqual({ ok: true, envelope: { version: 1, message } });
  });

  it('accepts join_session and joined', () => {
    const join = '{"version":1,"message":{"type":"join_session","session_id":"s"}}';
    const joined = '{"version":1,"message":{"type":"joined","session_id":"s","access":"write"}}';
    expect(replyForTextFrame(join)).toBeUndefined();
    expect(replyForTextFrame(joined)).toBeUndefined();
  });

  it('rejects join_session and joined with wrong field types', () => {
    const frame = (message: string) => `{"version":1,"message":${message}}`;
    expect(replyForTextFrame(frame('{"type":"join_session"}'))).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame(frame('{"type":"join_session","session_id":7}'))).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame(frame('{"type":"joined","session_id":"s"}'))).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame(frame('{"type":"joined","session_id":"s","access":"root"}'))).toBe(
      INVALID_MESSAGE,
    );
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

  // serde_json::from_str::<Envelope> fails for anything that is not a complete
  // envelope, and the Rust relay answered invalid_message in that case.
  it('rejects valid JSON that is not an envelope as an invalid message', () => {
    expect(replyForTextFrame('[1,2,3]')).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame('null')).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame('42')).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame('{"version":999}')).toBe(INVALID_MESSAGE);
  });

  it('rejects a compatible version without a valid message', () => {
    expect(replyForTextFrame('{"version":1}')).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame('{"version":1,"message":"hola"}')).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame('{"version":1,"message":{"type":"unknown"}}')).toBe(INVALID_MESSAGE);
    expect(
      replyForTextFrame('{"version":1,"message":{"type":"access_changed","session_id":"s"}}'),
    ).toBe(INVALID_MESSAGE);
  });

  it('rejects wrong field types like serde does', () => {
    const access = (fields: string) =>
      `{"version":1,"message":{"type":"access_changed",${fields}}}`;
    const output = (data: string) =>
      `{"version":1,"message":{"type":"terminal_output","session_id":"s","terminal_id":"t","data":${data}}}`;
    expect(replyForTextFrame(output('[104,256]'))).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame(output('[-1]'))).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame(output('[1.5]'))).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame(output('"hi"'))).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame(access('"session_id":"s","user_id":"u","access":"admin"'))).toBe(
      INVALID_MESSAGE,
    );
    expect(replyForTextFrame(access('"session_id":1,"user_id":"u","access":"view"'))).toBe(
      INVALID_MESSAGE,
    );
  });

  it('accepts only integer versions that fit in a u16', () => {
    const message = '{"type":"access_changed","session_id":"s","user_id":"u","access":"none"}';
    expect(replyForTextFrame(`{"version":"1","message":${message}}`)).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame(`{"version":1.0,"message":${message}}`)).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame(`{"version":1e0,"message":${message}}`)).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame(`{"version":-1,"message":${message}}`)).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame(`{"version":65536,"message":${message}}`)).toBe(INVALID_MESSAGE);
    expect(replyForTextFrame(`{"version":65535,"message":${message}}`)).toBe(
      INCOMPATIBLE_PROTOCOL_VERSION,
    );
  });

  it('ignores unknown fields like serde does', () => {
    const text =
      '{"version":1,"extra":true,"message":{"type":"terminal_input","session_id":"s","terminal_id":"t","user_id":"u","data":[0,255],"note":"x"}}';
    expect(replyForTextFrame(text)).toBeUndefined();
  });
});
