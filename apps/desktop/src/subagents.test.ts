import { describe, expect, it } from "vitest";

import { buildSubagentTree } from "./subagents";
import type { Subagent } from "./subagentsApi";

describe("buildSubagentTree", () => {
  it("devuelve lista vacía si no hay subagentes", () => {
    expect(buildSubagentTree([])).toEqual([]);
  });

  it("subagentes con parentId null son raíces", () => {
    const list: Subagent[] = [
      {
        id: "s1",
        parentId: null,
        agent: "claude-code",
        kind: "task",
        label: "Task 1",
        status: "running",
      },
      {
        id: "s2",
        parentId: null,
        agent: "opencode",
        kind: "task",
        label: "Task 2",
        status: "completed",
      },
    ];

    const tree = buildSubagentTree(list);
    expect(tree).toHaveLength(2);
    expect(tree[0].id).toBe("s1");
    expect(tree[0].children).toEqual([]);
    expect(tree[1].id).toBe("s2");
    expect(tree[1].children).toEqual([]);
  });

  it("subagente con parentId que no coincide con otro subagente se considera raíz", () => {
    const list: Subagent[] = [
      {
        id: "s1",
        parentId: "main-session-id-not-in-list",
        agent: "codex",
        kind: "spawn",
        label: "Spawned worker",
        status: "running",
      },
    ];

    const tree = buildSubagentTree(list);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("s1");
    expect(tree[0].children).toEqual([]);
  });

  it("anida subagentes hijos bajo su padre directo", () => {
    const list: Subagent[] = [
      {
        id: "root-1",
        parentId: null,
        agent: "claude-code",
        kind: "task",
        label: "Root Task",
        status: "running",
      },
      {
        id: "child-1",
        parentId: "root-1",
        agent: "claude-code",
        kind: "task",
        label: "Child Task 1",
        status: "completed",
      },
      {
        id: "child-2",
        parentId: "root-1",
        agent: "claude-code",
        kind: "task",
        label: "Child Task 2",
        status: "failed",
      },
    ];

    const tree = buildSubagentTree(list);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("root-1");
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children[0].id).toBe("child-1");
    expect(tree[0].children[1].id).toBe("child-2");
  });

  it("soporta múltiples niveles de anidamiento", () => {
    const list: Subagent[] = [
      {
        id: "lvl-1",
        parentId: null,
        agent: "claude-code",
        kind: "task",
        label: "Level 1",
        status: "running",
      },
      {
        id: "lvl-2",
        parentId: "lvl-1",
        agent: "claude-code",
        kind: "task",
        label: "Level 2",
        status: "running",
      },
      {
        id: "lvl-3",
        parentId: "lvl-2",
        agent: "claude-code",
        kind: "task",
        label: "Level 3",
        status: "completed",
      },
    ];

    const tree = buildSubagentTree(list);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("lvl-1");
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].id).toBe("lvl-2");
    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0].children[0].id).toBe("lvl-3");
  });
});
