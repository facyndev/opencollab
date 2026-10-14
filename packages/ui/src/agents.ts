import antigravityLogo from "./assets/agents/antigravitycli-logo.svg";
import claudeLogo from "./assets/agents/claudecode-logo.svg";
import codexLogo from "./assets/agents/codex-logo.svg";
import grokLogo from "./assets/agents/grok-xai-logo.svg";
import opencodeLogo from "./assets/agents/opencode-logo.svg";

// Presentación de los agentes que detecta el núcleo (ver
// apps/desktop/core/application/src/agent_detection.rs: los ids tienen que coincidir).

export type AgentId = "claude-code" | "opencode" | "codex" | "antigravity-cli" | "grok";

type AgentInfo = { name: string; badge: string; logoFile: string; logo: string | null };

const catalog: Record<AgentId, AgentInfo> = {
  "claude-code": { name: "Claude Code", badge: "CC", logoFile: "claudecode-logo.svg", logo: claudeLogo },
  opencode: { name: "OpenCode", badge: "OC", logoFile: "opencode-logo.svg", logo: opencodeLogo },
  codex: { name: "Codex", badge: "CX", logoFile: "codex-logo.svg", logo: codexLogo },
  "antigravity-cli": { name: "Antigravity CLI", badge: "AG", logoFile: "antigravitycli-logo.svg", logo: antigravityLogo },
  grok: { name: "Grok", badge: "GK", logoFile: "grok-xai-logo.svg", logo: grokLogo },
};

export function agentInfo(id: AgentId) {
  return catalog[id];
}
