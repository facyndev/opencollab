// Adaptador del frontend hacia el núcleo Rust: la UI no conoce PTYs ni el relay,
// solo estos comandos y eventos de Tauri.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { AgentId } from "./agents";
import { parseCollabStatus, type CollabStatus } from "./collabStatus";

type OutputPayload = { terminalId: string; data: number[] };
type ExitPayload = { terminalId: string };
/// El primero es el agente principal de la terminal; los siguientes son los que
/// ese agente tiene anidados.
type AgentPayload = { terminalId: string; agents: AgentId[] };

export type TerminalHandlers = {
  onOutput: (data: Uint8Array) => void;
  onExit: () => void;
  /// Agentes conocidos que corren en la terminal (lista vacía = ninguno).
  onAgent: (agents: AgentId[]) => void;
};

const handlers = new Map<string, TerminalHandlers>();
// La salida puede llegar antes de que la UI registre sus handlers
// (el PTY arranca dentro de open_shell), así que se guarda hasta entonces.
const pending = new Map<string, Uint8Array[]>();
const exitedEarly = new Set<string>();
const agentEarly = new Map<string, AgentId[]>();

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
      if (handler) handler.onAgent(payload.agents);
      else agentEarly.set(payload.terminalId, payload.agents);
    }),
  ]).then(() => undefined);
  return listening;
}

export type OpenedTerminal = { terminalId: string; name: string; cwd: string | null };

/// `cwd`: carpeta inicial; `null` = la por defecto. Si ya no existe, el núcleo usa la por defecto.
export async function openShell(cols: number, rows: number, cwd: string | null = null): Promise<OpenedTerminal> {
  await ensureListening();
  return invoke<OpenedTerminal>("open_shell", { cols, rows, cwd });
}

/// Subcarpetas de `path`, ya ordenadas por el núcleo.
export function listSubdirectories(path: string): Promise<string[]> {
  return invoke<string[]>("list_subdirectories", { path });
}

/// Estado actual de colaboración (relay + colaboradores). Sondea el relay: puede tardar hasta su timeout.
export async function getCollabStatus(): Promise<CollabStatus> {
  return parseCollabStatus(await invoke<unknown>("collab_status"));
}

/// Cambios del estado de colaboración que emite el núcleo. Devuelve la función para dejar de escuchar.
export function onCollabStatus(handler: (status: CollabStatus) => void): Promise<() => void> {
  return listen<unknown>("collab-status", ({ payload }) => handler(parseCollabStatus(payload)));
}

export function closeTerminal(terminalId: string): Promise<void> {
  return invoke("close_terminal", { terminalId });
}

export function attachTerminal(terminalId: string, h: TerminalHandlers): () => void {
  handlers.set(terminalId, h);
  for (const chunk of pending.get(terminalId) ?? []) h.onOutput(chunk);
  pending.delete(terminalId);
  if (agentEarly.has(terminalId)) h.onAgent(agentEarly.get(terminalId) ?? []);
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
