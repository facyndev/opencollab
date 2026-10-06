import type { GitBranch } from "./terminalApi";

/// Cada cuánto se vuelve a leer la rama de la carpeta. Leer `HEAD` es barato.
export const BRANCH_POLL_MS = 3000;

export function sameBranch(a: GitBranch | null, b: GitBranch | null): boolean {
  return a?.name === b?.name && a?.detached === b?.detached;
}

/// Consulta la rama de `cwd` enseguida y cada `intervalMs`, e informa a
/// `onBranch`. Devuelve la función que lo detiene: limpia el intervalo y
/// descarta las respuestas que aún vuelan.
///
/// - Una respuesta más vieja que la última aplicada se ignora: con consultas
///   superpuestas, una lenta no puede pisar a una más nueva.
/// - Si una consulta falla y ya hay una rama conocida, se conserva (un error
///   transitorio no hace parpadear la rama); solo informa `null` si todavía no
///   se conoce ninguna.
export function watchBranch(
  cwd: string,
  query: (cwd: string) => Promise<GitBranch | null>,
  onBranch: (branch: GitBranch | null) => void,
  intervalMs: number = BRANCH_POLL_MS,
): () => void {
  let stale = false;
  let issued = 0;
  let applied = 0;
  let known = false;
  const refresh = () => {
    const seq = ++issued;
    query(cwd)
      .then((result) => {
        if (stale || seq < applied) return;
        applied = seq;
        known = true;
        onBranch(result);
      })
      .catch(() => {
        if (stale || seq < applied || known) return;
        applied = seq;
        onBranch(null);
      });
  };
  refresh();
  const timer = setInterval(refresh, intervalMs);
  return () => {
    stale = true;
    clearInterval(timer);
  };
}
