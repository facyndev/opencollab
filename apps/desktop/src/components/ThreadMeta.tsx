import { VscBell, VscCircleFilled } from "react-icons/vsc";

import type { Activity } from "../activity";
import "./ThreadMeta.css";

type Props = {
  /// `null` = sin dato (o la terminal no corre un agente): no se muestra.
  activity: Activity | null;
  attention: boolean;
};

/// Línea secundaria bajo cada terminal del hilo, con datos que valen para
/// cualquier agente: actividad, tiempo corriendo y rama de git.
export function ThreadMeta({ activity, attention }: Props) {
  if (!activity) return null;
  const tone = attention ? "attention" : activity;
  return (
    <div className={`thread-meta thread-meta--${tone}`}>
      <span className="thread-meta-part thread-meta-activity">
        {attention ? (
          <VscBell size={11} aria-hidden="true" />
        ) : (
          <VscCircleFilled size={9} aria-hidden="true" />
        )}
        {attention ? "Needs attention" : activity === "working" ? "Working" : "Idle"}
      </span>
    </div>
  );
}
