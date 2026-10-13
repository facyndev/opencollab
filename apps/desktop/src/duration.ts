// Tiempo transcurrido en formato compacto para el sidebar.

/// `45s`, `12m`, `1h 05m`.
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/// Segundos enteros entre `startedAt` (segundos desde la época Unix, como lo
/// informa el núcleo) y `nowMs` (milisegundos). Nunca negativo.
export function elapsedSince(startedAt: number, nowMs: number): number {
  return Math.max(0, Math.floor(nowMs / 1000 - startedAt));
}
