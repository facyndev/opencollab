// Adaptador del frontend hacia el núcleo Rust: la UI no conoce PTYs ni el relay,
// solo estos comandos y eventos de Tauri.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { Activity } from "./activity";
import type { AgentId } from "./agents";

type OutputPayload = { terminalId: string; data: number[] };
type ExitPayload = { terminalId: string };
/// El primero es el agente principal de la terminal; los siguientes son los que
/// ese agente tiene anidados. `startedAt`: arranque del principal, en segundos
/// desde la época Unix (`null` si no corre ninguno).
type AgentPayload = { terminalId: string; agents: AgentId[]; startedAt: number | null };
/// El núcleo solo lo emite cuando el estado cambia.
type ActivityPayload = { terminalId: string; state: Activity };
type AgentSessionPayload = { terminalId: string; title: string | null };

export type TerminalHandlers = {
  onOutput: (data: Uint8Array) => void;
  onExit: () => void;
  /// Agentes conocidos que corren en la terminal (lista vacía = ninguno).
  onAgent: (agents: AgentId[], startedAt: number | null) => void;
  /// Título de sesión activo del agente en la terminal (`null` si no hay).
  onSessionTitle?: (title: string | null) => void;
  /// Actividad inferida de la salida del PTY (`working` / `idle`).
  onActivity?: (state: Activity) => void;
};

const handlers = new Map<string, TerminalHandlers>();
// La salida puede llegar antes de que la UI registre sus handlers
// (el PTY arranca dentro de open_shell), así que se guarda hasta entonces.
const pending = new Map<string, Uint8Array[]>();
const exitedEarly = new Set<string>();
const agentEarly = new Map<string, { agents: AgentId[]; startedAt: number | null }>();
const sessionTitleEarly = new Map<string, string | null>();
const activityEarly = new Map<string, Activity>();

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
    listen<AgentSessionPayload>("terminal-agent-session", ({ payload }) => {
      const handler = handlers.get(payload.terminalId);
      if (handler?.onSessionTitle) handler.onSessionTitle(payload.title);
      else sessionTitleEarly.set(payload.terminalId, payload.title);
    }),
    listen<ActivityPayload>("terminal-activity", ({ payload }) => {
      const handler = handlers.get(payload.terminalId);
      if (handler?.onActivity) handler.onActivity(payload.state);
      else activityEarly.set(payload.terminalId, payload.state);
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
  if (sessionTitleEarly.has(terminalId)) {
    h.onSessionTitle?.(sessionTitleEarly.get(terminalId) ?? null);
    sessionTitleEarly.delete(terminalId);
  }
  const activity = activityEarly.get(terminalId);
  if (activity) h.onActivity?.(activity);
  activityEarly.delete(terminalId);
  if (exitedEarly.delete(terminalId)) h.onExit();
  return () => handlers.delete(terminalId);
}

export function getAgentSessionTitle(terminalId: string): Promise<string | null> {
  return invoke<string | null>("agent_session_title", { terminalId });
}

export function writeTerminal(terminalId: string, data: string): Promise<void> {
  return invoke("write_terminal", { terminalId, data });
}

export function resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
  return invoke("resize_terminal", { terminalId, cols, rows });
}
