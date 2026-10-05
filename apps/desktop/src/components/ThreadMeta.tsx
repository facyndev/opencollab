import { VscBell, VscCircleFilled, VscError, VscGitBranch, VscShield } from "react-icons/vsc";

import { describeAgent, type AgentState, type AgentTone } from "../agentState";
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
};

/// Línea secundaria bajo cada terminal del hilo, con datos que valen para
/// cualquier agente: herramienta en curso, aprobación o error cuando el
/// adaptador los informa, y tiempo corriendo. El estado va junto al título
/// (`ThreadState`) y la rama cuelga del hilo (`ThreadBranch`).
export function ThreadMeta({ agent, attention, startedAt }: Props) {
  const { tone, detail } = describeAgent(agent, attention);
  if (!detail && startedAt === null) return null;
  return (
    <div className={`thread-meta thread-meta--${tone}`}>
      {detail && (
        <span className="thread-meta-part thread-meta-tool" title={detail}>
          {detail}
        </span>
      )}
      {startedAt !== null && <Uptime startedAt={startedAt} />}
    </div>
  );
}

/// Estado del agente junto al título de su terminal: reemplaza al punto cuando
/// hay un agente con estado conocido. `null` si no hay estado que mostrar.
export function ThreadState({ tone, label }: { tone: AgentTone; label: string }) {
  if (tone === "none") return null;
  return (
    <span className={`thread-state thread-state--${tone}`} title={label}>
      <span className="thread-state-sep"> · </span>
      <StateIcon tone={tone} />
      <span className="thread-state-label">{label}</span>
    </span>
  );
}

/// Rama de git de la carpeta, como una línea más del hilo (misma forma que un
/// agente anidado).
export function ThreadBranch({ branch, onClick }: { branch: GitBranch; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        className="thread-item thread-item--sub thread-branch"
        title={branch.detached ? `Detached HEAD at ${branch.name}` : `Branch ${branch.name}`}
        onClick={onClick}
      >
        <VscGitBranch size={11} aria-hidden="true" />
        <span className="thread-label">{branch.name}</span>
      </button>
    </li>
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
