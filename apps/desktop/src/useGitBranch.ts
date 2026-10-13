import { useEffect, useState } from "react";

import { sameBranch, watchBranch } from "./branchWatch";
import { gitBranch, type GitBranch } from "./terminalApi";

/// Rama de git de `cwd` (`null` fuera de un repositorio o si no se conoce la
/// carpeta). Se vuelve a consultar al cambiar `cwd`, cada vez que cambia
/// `refreshKey` (p. ej. cuando un agente termina) y periódicamente: OSC 7 solo
/// se emite en el prompt, así que un cambio de rama mientras corre un agente (o
/// hecho por otra terminal en la misma carpeta) no avisa por ningún otro lado.
export function useGitBranch(cwd: string | null, refreshKey: unknown): GitBranch | null {
  const [branch, setBranch] = useState<GitBranch | null>(null);

  useEffect(() => {
    if (!cwd) {
      setBranch(null);
      return;
    }
    return watchBranch(cwd, gitBranch, (result) =>
      setBranch((current) => (sameBranch(current, result) ? current : result)),
    );
  }, [cwd, refreshKey]);

  return branch;
}
