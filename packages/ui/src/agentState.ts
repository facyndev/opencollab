// Estado de un agente tal como lo reduce el núcleo (`AgentState` en
// crates/application/src/agent_state.rs; el evento `terminal-agent-state` lo
// trae ya reducido) y cómo se muestra en el hilo del sidebar. Lógica pura.

export type AgentStatus = "working" | "idle";

export type AgentState = {
  /// `null` hasta que llega el primer evento.
  status: AgentStatus | null;
  tool: { name: string; input?: string } | null;
  approval: { requestId: string; description: string } | null;
  lastMessage: string | null;
  completed: boolean;
  error: string | null;
};

export const emptyAgentState: AgentState = {
  status: null,
  tool: null,
  approval: null,
  lastMessage: null,
  completed: false,
  error: null,
};

const TOOL_MAX = 44;
const APPROVAL_MAX = 56;
const ERROR_MAX = 56;

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/// `Bash: echo hi`, recortado.
export function toolLabel(tool: { name: string; input?: string }, max: number = TOOL_MAX): string {
  return truncate(tool.input ? `${tool.name}: ${tool.input}` : tool.name, max);
}

export type AgentTone = "none" | "working" | "idle" | "attention" | "approval" | "error";

export type AgentDescription = { tone: AgentTone; label: string; detail: string | null };

/// Qué mostrar de un agente. Precedencia: error > aprobación pendiente > atención
/// (terminó sin que se mirara) > trabajando / inactivo.
export function describeAgent(state: AgentState | null, attention: boolean): AgentDescription {
  if (!state || (state.status === null && !state.error && !state.approval)) {
    return { tone: "none", label: "", detail: null };
  }
  if (state.error) {
    return { tone: "error", label: "Error", detail: truncate(state.error, ERROR_MAX) };
  }
  if (state.approval) {
    const label = truncate(`Needs approval: ${state.approval.description}`, APPROVAL_MAX);
    return { tone: "approval", label, detail: null };
  }
  if (attention) return { tone: "attention", label: "Needs attention", detail: null };
  if (state.status === "working") {
    return { tone: "working", label: "Working", detail: state.tool ? toolLabel(state.tool) : null };
  }
  return { tone: "idle", label: "Idle", detail: null };
}
