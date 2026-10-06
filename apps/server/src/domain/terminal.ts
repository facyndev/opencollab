import { DomainError } from './error';
import type { TerminalId } from './ids';

// How to launch an agent (or a shell). Agnostic: any CLI is a profile.
export interface AgentProfile {
  readonly name: string;
  readonly command: string;
  readonly args: string[];
  readonly env: [string, string][];
  readonly cwd?: string;
}

export function newAgentProfile(
  name: string,
  command: string,
  opts: { args?: string[]; env?: [string, string][]; cwd?: string } = {},
): AgentProfile {
  if (command.trim() === '') throw new DomainError({ code: 'EmptyCommand' });
  // Copies, so the caller keeps no handle on the profile's internals.
  const args = [...(opts.args ?? [])];
  const env = (opts.env ?? []).map(([k, v]): [string, string] => [k, v]);
  const profile = { name, command, args, env };
  return opts.cwd === undefined ? profile : { ...profile, cwd: opts.cwd };
}

// A PTY inside a session running an `AgentProfile`.
export interface Terminal {
  readonly id: TerminalId;
  readonly profile: AgentProfile;
}
