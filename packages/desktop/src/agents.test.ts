import { describe, expect, it } from "vitest";

import { agentInfo, type AgentId } from "./agents";

describe("agents catalog", () => {
  const agents: AgentId[] = ["claude-code", "opencode", "codex", "antigravity-cli", "grok"];

  it("provee informacion para todos los agentes conocidos", () => {
    for (const id of agents) {
      const info = agentInfo(id);
      expect(info).toBeDefined();
      expect(info.name.length).toBeGreaterThan(0);
      expect(info.badge.length).toBeGreaterThan(0);
      expect(info.logoFile.endsWith(".svg")).toBe(true);
      expect(info.logo).not.toBeNull();
    }
  });

  it("configura grok con su logo oficial grok-xai-logo.svg", () => {
    const grok = agentInfo("grok");
    expect(grok.name).toBe("Grok");
    expect(grok.badge).toBe("GK");
    expect(grok.logoFile).toBe("grok-xai-logo.svg");
    expect(grok.logo).toBeTruthy();
  });
});
