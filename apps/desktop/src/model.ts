// Estado de UI. Workspaces y sesiones viven acá hasta que el núcleo exponga
// comandos para ellos; las terminales sí son PTYs reales del núcleo.

import type { Activity } from "./activity";
import type { AgentId } from "./agents";
import type { GitBranch } from "./terminalApi";

export type PaneStatus = "starting" | "running" | "done" | "failed";

/// Qué corre en una terminal: la shell, si se detectó, los agentes, y su carpeta
/// actual. `agents` viene ordenado del más cercano a la shell al más profundo: el
/// primero es el agente principal de la terminal y los demás son los que este
/// tiene anidados.
export type PaneMeta = {
  shellName: string | null;
  agents: AgentId[];
  cwd: string | null;
  sessionTitle?: string | null;
  /// Actividad inferida de la salida; `null` hasta que el núcleo informa algo.
  /// Arranque del agente principal (segundos desde la época Unix); `null` si no hay agente.
  startedAt?: number | null;
  /// Rama de git de la carpeta actual; `null` fuera de un repositorio.
  branch?: GitBranch | null;
  activity?: Activity | null;
  /// Terminó de trabajar sin que su panel estuviera enfocado y aún no se miró.
  attention?: boolean;
  terminalId?: string | null;
};

export type Pane = {
  id: string;
  /// Orden de creación. El DOM se renderiza siempre en este orden (estable) para
  /// que xterm nunca se mueva; la posición visual la da el orden de `Session.panes`.
  seq: number;
  /// Ventana chica que solo muestra el header.
  minimized: boolean;
  /// Carpeta en la que arranca la shell (`null` = la por defecto del núcleo).
  initialCwd: string | null;
};

export type Session = {
  id: string;
  name: string;
  /// En orden visual: arrastrar paneles reordena este array.
  panes: Pane[];
};

export type Workspace = {
  id: string;
  name: string;
  members: number;
  sessions: Session[];
};

export type Layout = "grid" | "columns" | "single";

export type LocalUser = { name: string; initials: string };

export const localUser: LocalUser = { name: "Facundo", initials: "FG" };

let counter = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${counter++}`;

let paneSeq = 0;
export function newPane(initialCwd: string | null = null): Pane {
  return { id: newId("pane"), seq: paneSeq++, minimized: false, initialCwd };
}

/// Agrega `pane` justo después de `afterId` (o al final si no está).
export function insertPaneAfter(panes: Pane[], afterId: string | null, pane: Pane): Pane[] {
  const i = afterId ? panes.findIndex((p) => p.id === afterId) : -1;
  if (i < 0) return [...panes, pane];
  return [...panes.slice(0, i + 1), pane, ...panes.slice(i + 1)];
}

/// Intercambia dos paneles de lugar.
export function swapPanes(panes: Pane[], a: string, b: string): Pane[] {
  const i = panes.findIndex((p) => p.id === a);
  const j = panes.findIndex((p) => p.id === b);
  if (i < 0 || j < 0) return panes;
  const next = [...panes];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function newSession(name: string): Session {
  return { id: newId("session"), name, panes: [] };
}

export function newWorkspace(name: string): Workspace {
  return { id: newId("ws"), name, members: 1, sessions: [newSession("Sesión 1")] };
}

export const statusLabel: Record<PaneStatus, string> = {
  starting: "Starting",
  running: "Running",
  done: "Done",
  failed: "Failed",
};

/// Resumen de una sesión para el sidebar, derivado del estado real de sus terminales.
export function sessionSummary(panes: Pane[], statuses: Record<string, PaneStatus>) {
  const n = panes.length;
  if (n === 0) return { tone: "idle" as const, text: "No terminals" };
  const list = panes.map((p) => statuses[p.id] ?? "starting");
  const live = list.filter((s) => s === "running" || s === "starting").length;
  const label = `${n} terminal${n === 1 ? "" : "s"}`;
  if (list.includes("failed")) return { tone: "failed" as const, text: `${label} · failed` };
  if (live > 0) return { tone: "live" as const, text: `${label} · ${live} live` };
  return { tone: "done" as const, text: `${label} · done` };
}
