// "Necesita atención" a partir del estado (working / idle) de una terminal: es
// estado de UI, no del núcleo, porque depende del foco. Lógica pura para testearla.

import type { AgentStatus } from "./agentState";

export type Activity = AgentStatus;

export type ActivityState = {
  /// `null` hasta que el núcleo informa algo.
  activity: Activity | null;
  /// Terminó de trabajar mientras su panel no estaba enfocado y todavía no se miró.
  attention: boolean;
};

export const initialActivity: ActivityState = { activity: null, attention: false };

/// Llega un cambio de actividad; `focused` dice si el panel está enfocado en ese momento.
export function applyActivity(state: ActivityState, next: Activity, focused: boolean): ActivityState {
  const finishedUnseen = state.activity === "working" && next === "idle" && !focused;
  const attention = next === "working" ? false : state.attention || finishedUnseen;
  return { activity: next, attention };
}

/// El panel recibió el foco: lo pendiente ya se vio.
export function applyFocus(state: ActivityState): ActivityState {
  return state.attention ? { ...state, attention: false } : state;
}

export type WatchInputs = {
  focused: boolean;
  hidden: boolean;
  minimized: boolean;
  windowFocused: boolean;
};

/// El panel está activo dentro de la grilla (enfocado, visible y no minimizado).
export function isPaneActive(v: Pick<WatchInputs, "focused" | "hidden" | "minimized">): boolean {
  return v.focused && !v.hidden && !v.minimized;
}

/// El usuario está mirando el panel: enfocado, visible (no oculto ni minimizado) y con
/// la ventana de la app en primer plano. Solo entonces un cambio de actividad cuenta como visto.
export function isWatching(v: WatchInputs): boolean {
  return isPaneActive(v) && v.windowFocused;
}

/// Solo limpia `attention` automáticamente cuando el panel en sí pasa a estar activo
/// mientras la ventana tiene foco (cambiar de panel, de sesión o desminimizar).
/// Si el panel ya estaba activo y solo volvió el foco de la ventana (`windowFocused: false -> true`),
/// no se limpia hasta que el usuario interactúe con el panel o lo seleccione explícitamente.
export function shouldClearAttentionOnWatchChange(prev: WatchInputs, next: WatchInputs): boolean {
  return !isPaneActive(prev) && isWatching(next);
}
