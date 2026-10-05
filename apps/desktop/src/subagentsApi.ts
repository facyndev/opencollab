// Adaptador hacia el núcleo para subagentes y hooks de los agentes. Igual que
// terminalApi.ts: la UI solo conoce estos comandos y eventos de Tauri.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { AgentId } from "./agents";

export type SubagentStatus = "running" | "completed" | "failed";

export type Subagent = {
  id: string;
  /// Id del padre; puede ser el de la sesión principal del agente (no un subagente).
  parentId: string | null;
  agent: AgentId;
  kind: string | null;
  label: string | null;
  status: SubagentStatus;
};

export type TerminalSubagents = { terminalId: string; subagents: Subagent[] };

export type HookState = "unsupported" | "notInstalled" | "installed" | "error";

export type HookStatus = { agent: AgentId; status: HookState; error?: string };

/// Foto actual de los subagentes de una terminal (carga inicial).
export function getSubagents(terminalId: string): Promise<TerminalSubagents> {
  return invoke<TerminalSubagents>("subagent_snapshot", { terminalId });
}

/// Cada cambio llega con la lista completa de la terminal (vacía al cerrarse).
/// Devuelve la función que cancela la suscripción.
export function onTerminalSubagents(handler: (update: TerminalSubagents) => void): Promise<() => void> {
  return listen<TerminalSubagents>("terminal-subagents", ({ payload }) => handler(payload));
}

export function getHookStatus(): Promise<HookStatus[]> {
  return invoke<HookStatus[]>("hook_status");
}

/// Modifica la configuración real del agente: llamar solo tras confirmación del usuario.
export function installAgentHooks(agent: AgentId): Promise<void> {
  return invoke("install_agent_hooks", { agent });
}

export function uninstallAgentHooks(agent: AgentId): Promise<void> {
  return invoke("uninstall_agent_hooks", { agent });
}
