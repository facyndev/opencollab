// Adaptador del frontend hacia el núcleo Rust: la UI no conoce PTYs ni el relay,
// solo estos comandos y eventos de Tauri.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { AgentId } from "./agents";
import type { AgentState } from "./agentState";
import { parseCollabStatus, type CollabStatus } from "./collabStatus";

type OutputPayload = { terminalId: string; data: number[] };
type ExitPayload = { terminalId: string };
/// El primero es el agente principal de la terminal; los siguientes son los que
/// ese agente tiene anidados. `startedAt`: arranque del principal, en segundos
/// desde la época Unix (`null` si no corre ninguno).
type AgentPayload = { terminalId: string; agents: AgentId[]; startedAt: number | null };
/// Estado reducido del agente (ver `agentState.ts`); el núcleo solo lo emite cuando cambia.
type AgentStatePayload = { terminalId: string; state: AgentState };

export type TerminalHandlers = {
  onOutput: (data: Uint8Array) => void;
  onExit: () => void;
  /// Agentes conocidos que corren en la terminal (lista vacía = ninguno).
  onAgent: (agents: AgentId[], startedAt: number | null) => void;
  /// Estado del agente reducido por el núcleo a partir de los `AgentEvent`s de la terminal.
  onAgentState?: (state: AgentState) => void;
};

const handlers = new Map<string, TerminalHandlers>();
// La salida puede llegar antes de que la UI registre sus handlers
// (el PTY arranca dentro de open_shell), así que se guarda hasta entonces.
const pending = new Map<string, Uint8Array[]>();
const exitedEarly = new Set<string>();
const agentEarly = new Map<string, { agents: AgentId[]; startedAt: number | null }>();
const agentStateEarly = new Map<string, AgentState>();

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
      const startedAt = payload.startedAt ?? null;
      if (handler) handler.onAgent(payload.agents, startedAt);
      else agentEarly.set(payload.terminalId, { agents: payload.agents, startedAt });
    }),
    listen<AgentStatePayload>("terminal-agent-state", ({ payload }) => {
      const handler = handlers.get(payload.terminalId);
      if (handler?.onAgentState) handler.onAgentState(payload.state);
      else agentStateEarly.set(payload.terminalId, payload.state);
    }),
  ]).then(() => undefined);
  return listening;
}

/// Rama de git de una carpeta; `name` es el SHA corto si `HEAD` está desacoplado.
export type GitBranch = { name: string; detached: boolean };

/// Rama de la carpeta, o `null` si no está dentro de un repositorio.
export function gitBranch(path: string): Promise<GitBranch | null> {
  return invoke<GitBranch | null>("git_branch", { path });
}

export type OpenedTerminal = { terminalId: string; name: string; cwd: string | null };

/// `cwd`: carpeta inicial; `null` = la por defecto. Si ya no existe, el núcleo usa la por defecto.
/// `agent`: agente a ejecutar dentro de la shell (al salir, la terminal vuelve a la shell); `null` = solo la shell.
export async function openShell(
  cols: number,
  rows: number,
  cwd: string | null = null,
  agent: AgentId | null = null,
): Promise<OpenedTerminal> {
  await ensureListening();
  return invoke<OpenedTerminal>("open_shell", { cols, rows, cwd, agent });
}

let available: Promise<AgentId[]> | null = null;

/// Agentes conocidos instalados (encontrados en el PATH). Se consulta una vez; si falla, ninguno.
export function availableAgents(): Promise<AgentId[]> {
  available ??= invoke<AgentId[]>("available_agents").catch(() => []);
  return available;
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
  const agentInfo = agentEarly.get(terminalId);
  if (agentInfo) h.onAgent(agentInfo.agents, agentInfo.startedAt);
  agentEarly.delete(terminalId);
  const agentState = agentStateEarly.get(terminalId);
  if (agentState) h.onAgentState?.(agentState);
  agentStateEarly.delete(terminalId);
  if (exitedEarly.delete(terminalId)) h.onExit();
  return () => handlers.delete(terminalId);
}

export function writeTerminal(terminalId: string, data: string): Promise<void> {
  return invoke("write_terminal", { terminalId, data });
}

export function resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
  return invoke("resize_terminal", { terminalId, cols, rows });
}
