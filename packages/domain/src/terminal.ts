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
  // Snapshot metadata (S7): which agent the pane launches (null = plain shell)
  // and its collapsed state. Optional so legacy shapes still typecheck; the
  // factories below always produce the canonical defaults.
  readonly agent?: string | null;
  readonly minimized?: boolean;
}

// Creation input for a terminal: the explicit id powers the desktop's
// idempotent create (S7); the metadata mirrors the saved pane state.
export interface TerminalCreateOptions {
  readonly id?: TerminalId;
  readonly agent?: string | null;
  readonly minimized?: boolean;
}

// Partial terminal update (S7). Absent keys keep the current value; explicit
// nulls clear `cwd` and `agent`.
export interface TerminalPatch {
  readonly name?: string;
  readonly command?: string;
  readonly args?: string[];
  readonly cwd?: string | null;
  readonly agent?: string | null;
  readonly minimized?: boolean;
}

// Canonical terminal constructor: metadata is always present in memory, so
// views and persistence never branch on missing keys.
export function newTerminal(id: TerminalId, profile: AgentProfile, opts: TerminalCreateOptions = {}): Terminal {
  return {
    id,
    profile,
    agent: opts.agent ?? null,
    minimized: opts.minimized ?? false,
  };
}
