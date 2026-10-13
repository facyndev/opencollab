// Estado de colaboración que muestra la status bar. Lo calcula el núcleo
// (sondeo del relay + participantes de la sesión); acá solo se valida y se
// define el valor inicial, que es honesto: sin relay y solo el usuario local.

export type CollabStatus = {
  connected: boolean;
  /// Latencia medida contra el relay; `null` si no está conectado.
  syncMs: number | null;
  collaborators: number;
};

export const DEFAULT_COLLAB_STATUS: CollabStatus = { connected: false, syncMs: null, collaborators: 1 };

/// Convierte el payload del núcleo (`collab_status` / evento `collab-status`) en un
/// `CollabStatus`. Si viene malformado cae a los valores honestos, nunca inventa.
export function parseCollabStatus(raw: unknown): CollabStatus {
  if (typeof raw !== "object" || raw === null) return DEFAULT_COLLAB_STATUS;
  const { connected, syncMs, collaborators } = raw as Record<string, unknown>;
  if (typeof connected !== "boolean") return DEFAULT_COLLAB_STATUS;
  if (typeof collaborators !== "number" || !Number.isInteger(collaborators) || collaborators < 0) {
    return DEFAULT_COLLAB_STATUS;
  }
  return {
    connected,
    syncMs: connected && typeof syncMs === "number" && Number.isFinite(syncMs) ? syncMs : null,
    collaborators,
  };
}
