import type { Subagent } from "./subagentsApi";

export type SubagentNode = Subagent & {
  children: SubagentNode[];
};

/// Construye el árbol de subagentes para renderizar en el sidebar.
/// Soportar jerarquía: subagentes raíz (`parentId === null` o cuyo `parentId` no coincide
/// con otro subagente) y anidados (hijos de otro subagente según `parentId`).
export function buildSubagentTree(subagents: Subagent[]): SubagentNode[] {
  const byId = new Map<string, SubagentNode>();
  const roots: SubagentNode[] = [];

  for (const s of subagents) {
    byId.set(s.id, { ...s, children: [] });
  }

  for (const s of subagents) {
    const node = byId.get(s.id)!;
    if (s.parentId && byId.has(s.parentId)) {
      byId.get(s.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}
