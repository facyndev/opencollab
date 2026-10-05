import { VscBell, VscCircleFilled, VscGitBranch } from "react-icons/vsc";

import type { Activity } from "../activity";
import type { GitBranch } from "../terminalApi";
import { elapsedSince, formatElapsed } from "../duration";
import { useNow } from "../useNow";
import "./ThreadMeta.css";

type Props = {
  /// `null` = sin dato (o la terminal no corre un agente): no se muestra.
  activity: Activity | null;
  attention: boolean;
  /// Arranque del agente (segundos desde la época Unix); `null` = no se muestra.
  startedAt: number | null;
  /// `null` = fuera de un repositorio: no se muestra.
  branch: GitBranch | null;
};

/// Línea secundaria bajo cada terminal del hilo, con datos que valen para
/// cualquier agente: actividad, tiempo corriendo y rama de git.
export function ThreadMeta({ activity, attention, startedAt, branch }: Props) {
  if (!activity && startedAt === null && !branch) return null;
  const tone = attention ? "attention" : (activity ?? "none");
  return (
    <div className={`thread-meta thread-meta--${tone}`}>
      {activity && (
        <span className="thread-meta-part thread-meta-activity">
          {attention ? (
            <VscBell size={11} aria-hidden="true" />
          ) : (
            <VscCircleFilled size={9} aria-hidden="true" />
          )}
          {attention ? "Needs attention" : activity === "working" ? "Working" : "Idle"}
        </span>
      )}
      {startedAt !== null && <Uptime startedAt={startedAt} />}
      {branch && (
        <span
          className="thread-meta-part thread-meta-branch"
          title={branch.detached ? `Detached HEAD at ${branch.name}` : `Branch ${branch.name}`}
        >
          <VscGitBranch size={11} aria-hidden="true" />
          <span className="thread-meta-branch-name">{branch.name}</span>
        </span>
      )}
    </div>
  );
}

/// Suscripto al temporizador compartido: solo este fragmento se re-renderiza.
function Uptime({ startedAt }: { startedAt: number }) {
  const now = useNow();
  return (
    <span className="thread-meta-part thread-meta-uptime" title="Agent running time">
      {formatElapsed(elapsedSince(startedAt, now))}
    </span>
  );
}
