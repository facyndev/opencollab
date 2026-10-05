// Actividad de una terminal (la infiere el núcleo de su salida) y "necesita
// atención": estado de UI, no del núcleo. Es lógica pura para poder testearla.

export type Activity = "working" | "idle";

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
