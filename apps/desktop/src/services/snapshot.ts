import { invoke } from "@tauri-apps/api/core";
import { adoptPaneSeq, isAgentId, type Pane, type Session, type Workspace } from "@opencollab/ui";

// Espeja StoredPane/StoredSession/StoredWorkspace del núcleo Rust
// (apps/desktop/core/application/src/storage.ts): solo el perfil de arranque
// de las terminales, nunca `env` ni scrollback (regla A1 del feature
// desktop-dual-storage). El `SNAPSHOT_VERSION` lo maneja el núcleo: acá viaja
// solo el array de workspaces.
export type SavedPane = {
  id: string;
  seq: number;
  minimized: boolean;
  initialCwd: string | null;
  agent: string | null;
};

export type SavedSession = { id: string; name: string; panes: SavedPane[] };

export type SavedWorkspace = { id: string; name: string; sessions: SavedSession[] };

export type SavedSnapshot = { workspaces: SavedWorkspace[] };

const savedPaneOf = (pane: Pane): SavedPane => ({
  id: pane.id,
  seq: pane.seq,
  minimized: pane.minimized,
  initialCwd: pane.initialCwd,
  agent: pane.agent,
});

const savedSessionOf = (session: Session): SavedSession => ({
  id: session.id,
  name: session.name,
  panes: session.panes.map(savedPaneOf),
});

export function toSavedWorkspaces(workspaces: Workspace[]): SavedWorkspace[] {
  return workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    // `members` (y cualquier otro estado volátil de la UI) queda fuera del snapshot.
    sessions: ws.sessions.map(savedSessionOf),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function paneOf(raw: unknown): Pane | null {
  if (!isRecord(raw)) return null;
  const { id, seq, minimized, initialCwd, agent } = raw;
  if (typeof id !== "string" || typeof seq !== "number" || typeof minimized !== "boolean")
    return null;
  if (initialCwd !== null && typeof initialCwd !== "string") return null;
  if (agent !== null && typeof agent !== "string") return null;
  // Un agente que ya no existe en el catálogo (snapshot viejo) pasa a
  // `null`: la terminal apertura plana en vez de romper la UI.
  return { id, seq, minimized, initialCwd, agent: isAgentId(agent) ? agent : null };
}

function sessionOf(raw: unknown): Session | null {
  if (!isRecord(raw)) return null;
  const { id, name, panes } = raw;
  if (typeof id !== "string" || typeof name !== "string" || !Array.isArray(panes)) return null;
  const restored: Pane[] = [];
  for (const item of panes) {
    const pane = paneOf(item);
    if (!pane) return null;
    // Los seq restaurados reservan su lugar: los `newPane` de esta corrida
    // generan seq mayores y no chocan (el orden visual del grid queda estable).
    adoptPaneSeq(pane.seq);
    restored.push(pane);
  }
  return { id, name, panes: restored };
}

function workspaceOf(raw: unknown): Workspace | null {
  if (!isRecord(raw)) return null;
  const { id, name, sessions } = raw;
  if (typeof id !== "string" || typeof name !== "string" || !Array.isArray(sessions)) return null;
  const restored: Session[] = [];
  for (const item of sessions) {
    const session = sessionOf(item);
    if (!session) return null;
    restored.push(session);
  }
  return { id, name, members: 1, sessions: restored };
}

/// Reconstruye los workspaces de la UI desde el payload del núcleo.
/// Todo payload inválido cae a `null` y quien llama arranca con el default:
/// el archivo lo valida antes Rust (quarentena de lo ilegible/versión futura),
/// así que acá solo queda blindarse ante un shape inesperado.
export function fromSavedSnapshot(saved: unknown): Workspace[] | null {
  if (!isRecord(saved) || !Array.isArray(saved.workspaces) || saved.workspaces.length === 0)
    return null;
  const restored: Workspace[] = [];
  for (const item of saved.workspaces) {
    const ws = workspaceOf(item);
    if (!ws) return null;
    restored.push(ws);
  }
  return restored;
}

/// Snapshot guardado del arranque anterior; `null` si no hay nada (primera
/// corrida, arranque limpio o cuarentena del último archivo corrupto).
export async function loadSnapshot(): Promise<Workspace[] | null> {
  const saved = await invoke<unknown>("snapshot_load");
  return fromSavedSnapshot(saved);
}

// Los guardados se encadenan: el snapshot chico escribe en milisegundos, pero
// dos writes concurrentes sobre el mismo archivo no deben cruzarse jamás.
let saveQueue: Promise<unknown> = Promise.resolve();

/// Guarda el estado persistente de los workspaces. Nunca rechaza: un error del
/// disco no debe tumbar la app (el próximo guardado lo reintenta igual).
export async function saveSnapshot(workspaces: Workspace[]): Promise<void> {
  const saved = toSavedWorkspaces(workspaces);
  const next = saveQueue
    .then(() => invoke("snapshot_save", { workspaces: saved }))
    .then(
      () => undefined,
      (error) => console.error("no se pudo guardar el snapshot:", error),
    );
  saveQueue = next;
  return next;
}
