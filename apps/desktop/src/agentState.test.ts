import { describe, expect, it } from "vitest";

import { describeAgent, emptyAgentState, toolLabel, truncate, type AgentState } from "./agentState";

const state = (patch: Partial<AgentState>): AgentState => ({ ...emptyAgentState, ...patch });

describe("truncate", () => {
  it("keeps short text and cuts long text with an ellipsis", () => {
    expect(truncate("echo hi", 20)).toBe("echo hi");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("toolLabel", () => {
  it("shows the tool and its input summary", () => {
    expect(toolLabel({ name: "Bash", input: "echo hi" })).toBe("Bash: echo hi");
  });

  it("shows only the name when there is no input", () => {
    expect(toolLabel({ name: "Read" })).toBe("Read");
  });

  it("truncates a long label", () => {
    const label = toolLabel({ name: "Bash", input: "x".repeat(200) }, 30);
    expect(label.length).toBe(30);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("describeAgent", () => {
  it("shows nothing without state or before the first event", () => {
    expect(describeAgent(null, false)).toEqual({ tone: "none", label: "", detail: null });
    expect(describeAgent(emptyAgentState, false).tone).toBe("none");
  });

  it("shows Working with the current tool", () => {
    const d = describeAgent(
      state({ status: "working", tool: { name: "Bash", input: "echo hi" } }),
      false,
    );
    expect(d).toEqual({ tone: "working", label: "Working", detail: "Bash: echo hi" });
  });

  it("shows Idle without detail", () => {
    expect(describeAgent(state({ status: "idle" }), false)).toEqual({
      tone: "idle",
      label: "Idle",
      detail: null,
    });
  });

  it("keeps the needs-attention behavior when idle and unseen", () => {
    expect(describeAgent(state({ status: "idle" }), true)).toEqual({
      tone: "attention",
      label: "Needs attention",
      detail: null,
    });
  });

  it("shows the pending approval with its description, above attention", () => {
    const d = describeAgent(
      state({
        status: "working",
        tool: { name: "Bash" },
        approval: { requestId: "r1", description: "run rm -rf build" },
      }),
      true,
    );
    expect(d).toEqual({
      tone: "approval",
      label: "Needs approval: run rm -rf build",
      detail: null,
    });
  });

  it("shows an error above everything else", () => {
    const d = describeAgent(
      state({ status: "idle", error: "exited with code 2", approval: { requestId: "r", description: "d" } }),
      true,
    );
    expect(d).toEqual({ tone: "error", label: "Error", detail: "exited with code 2" });
  });

  it("truncates long approval descriptions and errors", () => {
    const long = "y".repeat(300);
    const approval = describeAgent(
      state({ status: "working", approval: { requestId: "r", description: long } }),
      false,
    );
    expect(approval.label.length).toBeLessThan(80);
    expect(describeAgent(state({ status: "idle", error: long }), false).detail!.length).toBeLessThan(80);
  });
});
