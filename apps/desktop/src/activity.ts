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

/// El usuario está mirando el panel: enfocado, visible (no oculto ni minimizado) y con
/// la ventana de la app en primer plano. Solo entonces un cambio de actividad cuenta como visto.
export function isWatching(v: {
  focused: boolean;
  hidden: boolean;
  minimized: boolean;
  windowFocused: boolean;
}): boolean {
  return v.focused && !v.hidden && !v.minimized && v.windowFocused;
}
