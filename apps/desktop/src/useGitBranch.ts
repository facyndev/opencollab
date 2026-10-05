import { useEffect, useState } from "react";

import { gitBranch, type GitBranch } from "./terminalApi";

/// Rama de git de `cwd` (`null` fuera de un repositorio o si no se conoce la
/// carpeta). Se vuelve a consultar al cambiar `cwd` y cada vez que cambia
/// `refreshKey` (p. ej. cuando un agente termina: pudo haber cambiado de rama).
export function useGitBranch(cwd: string | null, refreshKey: unknown): GitBranch | null {
  const [branch, setBranch] = useState<GitBranch | null>(null);

  useEffect(() => {
    if (!cwd) {
      setBranch(null);
      return;
    }
    let stale = false;
    gitBranch(cwd)
      .then((result) => {
        if (!stale) setBranch((current) => sameBranch(current, result) ? current : result);
      })
      .catch(() => {
        if (!stale) setBranch(null);
      });
    return () => {
      stale = true;
    };
  }, [cwd, refreshKey]);

  return branch;
}

function sameBranch(a: GitBranch | null, b: GitBranch | null): boolean {
  return a?.name === b?.name && a?.detached === b?.detached;
}
