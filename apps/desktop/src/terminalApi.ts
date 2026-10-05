// Adaptador del frontend hacia el núcleo Rust: la UI no conoce PTYs ni el relay,
// solo estos comandos y eventos de Tauri.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { AgentId } from "./agents";

type OutputPayload = { terminalId: string; data: number[] };
type ExitPayload = { terminalId: string };
type AgentPayload = { terminalId: string; agent: AgentId | null };

export type TerminalHandlers = {
  onOutput: (data: Uint8Array) => void;
  onExit: () => void;
  /// Agente conocido que corre en la terminal (`null` = ninguno).
  onAgent: (agent: AgentId | null) => void;
};

const handlers = new Map<string, TerminalHandlers>();
// La salida puede llegar antes de que la UI registre sus handlers
// (el PTY arranca dentro de open_shell), así que se guarda hasta entonces.
const pending = new Map<string, Uint8Array[]>();
const exitedEarly = new Set<string>();
const agentEarly = new Map<string, AgentId | null>();

let listening: Promise<void> | null = null;

function ensureListening(): Promise<void> {
  listening ??= Promise.all([
    listen<OutputPayload>("terminal-output", ({ payload }) => {
      const data = Uint8Array.from(payload.data);
      const handler = handlers.get(payload.terminalId);
      if (handler) handler.onOutput(data);
      else pending.set(payload.terminalId, [...(pending.get(payload.terminalId) ?? []), data]);
    }),
    listen<ExitPayload>("terminal-exit", ({ payload }) => {
      const handler = handlers.get(payload.terminalId);
      if (handler) handler.onExit();
      else exitedEarly.add(payload.terminalId);
    }),
    listen<AgentPayload>("terminal-agent", ({ payload }) => {
      const handler = handlers.get(payload.terminalId);
      if (handler) handler.onAgent(payload.agent);
      else agentEarly.set(payload.terminalId, payload.agent);
    }),
  ]).then(() => undefined);
  return listening;
}

export type OpenedTerminal = { terminalId: string; name: string; cwd: string | null };

export async function openShell(cols: number, rows: number): Promise<OpenedTerminal> {
  await ensureListening();
  return invoke<OpenedTerminal>("open_shell", { cols, rows });
}

/// Subcarpetas de `path`, ya ordenadas por el núcleo.
export function listSubdirectories(path: string): Promise<string[]> {
  return invoke<string[]>("list_subdirectories", { path });
}

export function closeTerminal(terminalId: string): Promise<void> {
  return invoke("close_terminal", { terminalId });
}

export function attachTerminal(terminalId: string, h: TerminalHandlers): () => void {
  handlers.set(terminalId, h);
  for (const chunk of pending.get(terminalId) ?? []) h.onOutput(chunk);
  pending.delete(terminalId);
  if (agentEarly.has(terminalId)) h.onAgent(agentEarly.get(terminalId) ?? null);
  agentEarly.delete(terminalId);
  if (exitedEarly.delete(terminalId)) h.onExit();
  return () => handlers.delete(terminalId);
}

export function writeTerminal(terminalId: string, data: string): Promise<void> {
  return invoke("write_terminal", { terminalId, data });
}

export function resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
  return invoke("resize_terminal", { terminalId, cols, rows });
}
