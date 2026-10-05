// Presentación de los agentes que detecta el núcleo (ver
// crates/application/src/agent_detection.rs: los ids tienen que coincidir).

export type AgentId = "claude-code" | "opencode" | "codex" | "antigravity-cli" | "grok";

type AgentInfo = { name: string; badge: string; logoFile: string };

const catalog: Record<AgentId, AgentInfo> = {
  "claude-code": { name: "Claude Code", badge: "CC", logoFile: "claudecode-logo.svg" },
  opencode: { name: "OpenCode", badge: "OC", logoFile: "opencode-logo.svg" },
  codex: { name: "Codex", badge: "CX", logoFile: "codex-logo.svg" },
  "antigravity-cli": { name: "Antigravity CLI", badge: "AG", logoFile: "antigravitycli-logo.svg" },
  grok: { name: "Grok", badge: "GK", logoFile: "grok-xai-logo.svg" },
};

// Glob en vez de imports directos: si un SVG todavía no está en la carpeta,
// el build no falla y el panel muestra el badge de texto.
const logos = import.meta.glob<string>("./assets/agents/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

export function agentInfo(id: AgentId) {
  const info = catalog[id];
  return { ...info, logo: logos[`./assets/agents/${info.logoFile}`] ?? null };
}
