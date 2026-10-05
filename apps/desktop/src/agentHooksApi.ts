// Adaptador hacia el núcleo para hooks de los agentes.
import { invoke } from "@tauri-apps/api/core";
import type { AgentId } from "./agents";

export type HookState = "unsupported" | "notInstalled" | "installed" | "error";

export type HookStatus = { agent: AgentId; status: HookState; error?: string };

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
