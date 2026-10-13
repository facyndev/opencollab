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

  it('does not alias the input arrays', () => {
    const args = ['--x'];
    const env: [string, string][] = [['K', 'V']];
    const p = newAgentProfile('claude', 'claude', { args, env });
    args.push('--y');
    env[0][1] = 'changed';
    env.push(['A', 'B']);
    expect(p.args).toEqual(['--x']);
    expect(p.env).toEqual([['K', 'V']]);
  });
});
