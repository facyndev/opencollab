import { DEFAULT_COLLAB_STATUS } from "../collabStatus";
import { modKey, shiftKey } from "../shortcuts";

type Props = {
  connected?: boolean;
  syncMs?: number | null;
  collaborators?: number;
};

export function StatusBar({
  connected = DEFAULT_COLLAB_STATUS.connected,
  syncMs = DEFAULT_COLLAB_STATUS.syncMs,
  collaborators = DEFAULT_COLLAB_STATUS.collaborators,
}: Props = {}) {
  return (
    <footer className="statusbar">
      <span className="statusbar-item">
        <span className={`dot ${connected ? "dot--connected" : "dot--idle"}`} />
        {connected ? (
          <>Connected{syncMs != null ? ` · sync ${syncMs}ms` : ""}</>
        ) : (
          "Local · relay no conectado"
        )}
      </span>
      <span className="statusbar-item">
        {collaborators} {collaborators === 1 ? "collaborator" : "collaborators"}
      </span>
      <span className="statusbar-shortcuts">
        <kbd>{modKey}T</kbd> new · <kbd>{modKey}1-4</kbd> focus · <kbd>{modKey}{shiftKey}M</kbd> maximize
      </span>
    </footer>
  );
}
