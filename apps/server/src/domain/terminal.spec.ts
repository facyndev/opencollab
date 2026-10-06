import { describe, expect, it } from 'vitest';

import { newAgentProfile } from './terminal';
import { expectDomainError } from './test-helpers';

describe('AgentProfile', () => {
  it('rejects empty command', () => {
    expectDomainError(() => newAgentProfile('x', '   '), { code: 'EmptyCommand' });
  });

  it('defaults args, env and cwd', () => {
    expect(newAgentProfile('shell', 'sh')).toEqual({
      name: 'shell',
      command: 'sh',
      args: [],
      env: [],
    });
  });

  it('accepts args, env and cwd', () => {
    const p = newAgentProfile('claude', 'claude', {
      args: ['--x'],
      env: [['K', 'V']],
      cwd: '/tmp',
    });
    expect(p).toMatchObject({ args: ['--x'], env: [['K', 'V']], cwd: '/tmp' });
  });
});
