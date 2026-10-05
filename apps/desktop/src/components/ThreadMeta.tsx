import { VscBell, VscCircleFilled, VscError, VscGitBranch, VscShield } from "react-icons/vsc";

import { describeAgent, type AgentState } from "../agentState";
import type { GitBranch } from "../terminalApi";
import { elapsedSince, formatElapsed } from "../duration";
import { useNow } from "../useNow";
import "./ThreadMeta.css";

type Props = {
  /// Estado del agente; `null` = sin dato (o la terminal no corre un agente): no se muestra.
  agent: AgentState | null;
  attention: boolean;
  /// Arranque del agente (segundos desde la época Unix); `null` = no se muestra.
  startedAt: number | null;
  /// `null` = fuera de un repositorio: no se muestra.
  branch: GitBranch | null;
};

/// Línea secundaria bajo cada terminal del hilo, con datos que valen para
/// cualquier agente (estado, herramienta en curso, aprobación o error cuando el
/// adaptador los informa), tiempo corriendo y rama de git.
export function ThreadMeta({ agent, attention, startedAt, branch }: Props) {
  const { tone, label, detail } = describeAgent(agent, attention);
  const hasState = tone !== "none";
  if (!hasState && startedAt === null && !branch) return null;
  return (
    <div className={`thread-meta thread-meta--${tone}`}>
      {hasState && (
        <span className="thread-meta-part thread-meta-activity" title={label}>
          <StateIcon tone={tone} />
          {label}
        </span>
      )}
      {detail && (
        <span className="thread-meta-part thread-meta-tool" title={detail}>
          {detail}
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

function StateIcon({ tone }: { tone: string }) {
  if (tone === "attention") return <VscBell size={11} aria-hidden="true" />;
  if (tone === "approval") return <VscShield size={11} aria-hidden="true" />;
  if (tone === "error") return <VscError size={11} aria-hidden="true" />;
  return <VscCircleFilled size={9} aria-hidden="true" />;
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
