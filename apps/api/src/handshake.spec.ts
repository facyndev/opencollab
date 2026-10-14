import { describe, expect, it } from 'vitest';

import { SUBPROTOCOL, bearerFromProtocols } from './handshake';

describe('bearerFromProtocols', () => {
  it('extracts the token when opencollab.v1 comes with a bearer entry', () => {
    expect(bearerFromProtocols(`${SUBPROTOCOL}, bearer.aaa.bbb.ccc`)).toBe('aaa.bbb.ccc');
    expect(bearerFromProtocols('bearer.tok,opencollab.v1')).toBe('tok');
  });

  it('needs the opencollab.v1 subprotocol', () => {
    expect(bearerFromProtocols('bearer.tok')).toBeUndefined();
    expect(bearerFromProtocols('opencollab.v2, bearer.tok')).toBeUndefined();
  });

  it('needs exactly one non-empty bearer entry', () => {
    expect(bearerFromProtocols(SUBPROTOCOL)).toBeUndefined();
    expect(bearerFromProtocols(`${SUBPROTOCOL}, bearer.`)).toBeUndefined();
    expect(bearerFromProtocols(`${SUBPROTOCOL}, bearer.a, bearer.b`)).toBeUndefined();
  });

  it('rejects a missing or repeated header', () => {
    expect(bearerFromProtocols(undefined)).toBeUndefined();
    expect(bearerFromProtocols([`${SUBPROTOCOL}, bearer.a`, 'x'])).toBeUndefined();
  });
});
