import { useSyncExternalStore } from "react";

// Un único temporizador compartido por todos los que muestran tiempo corriendo:
// corre solo mientras haya alguien suscripto y re-renderiza solo a los suscriptos.
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/// Hora actual en ms, actualizada una vez por segundo.
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
