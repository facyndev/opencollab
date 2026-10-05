import type { GitBranch } from "./terminalApi";

/// Cada cuánto se vuelve a leer la rama de la carpeta. Leer `HEAD` es barato.
export const BRANCH_POLL_MS = 3000;

export function sameBranch(a: GitBranch | null, b: GitBranch | null): boolean {
  return a?.name === b?.name && a?.detached === b?.detached;
}

/// Consulta la rama de `cwd` enseguida y cada `intervalMs`, e informa cada
/// resultado a `onBranch` (`null` si la consulta falla). Devuelve la función que
/// lo detiene: limpia el intervalo y descarta las respuestas que aún vuelan.
export function watchBranch(
  cwd: string,
  query: (cwd: string) => Promise<GitBranch | null>,
  onBranch: (branch: GitBranch | null) => void,
  intervalMs: number = BRANCH_POLL_MS,
): () => void {
  let stale = false;
  const refresh = () => {
    query(cwd)
      .then((result) => {
        if (!stale) onBranch(result);
      })
      .catch(() => {
        if (!stale) onBranch(null);
      });
  };
  refresh();
  const timer = setInterval(refresh, intervalMs);
  return () => {
    stale = true;
    clearInterval(timer);
  };
}
