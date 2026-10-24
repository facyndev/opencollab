import { DEFAULT_COLLAB_STATUS, describeCollabMode, type StorageMode } from "../collabStatus";
import { modKey, shiftKey } from "../shortcuts";

type Props = {
  connected?: boolean;
  syncMs?: number | null;
  collaborators?: number;
  storageMode?: StorageMode;
};

export function StatusBar({
  connected = DEFAULT_COLLAB_STATUS.connected,
  syncMs = DEFAULT_COLLAB_STATUS.syncMs,
  collaborators = DEFAULT_COLLAB_STATUS.collaborators,
  storageMode,
}: Props = {}) {
  const collab = describeCollabMode(storageMode);
  const inactive = collab.inactive && !connected;
  const itemClass = `statusbar-item ${inactive ? "statusbar-item--inactive" : ""}`.trim();
  return (
    <footer className="statusbar">
      <span
        className={itemClass}
        title={inactive ? collab.statusBarTitle : undefined}
        data-collab-inactive={inactive || undefined}
      >
        <span className={`dot ${connected ? "dot--connected" : "dot--idle"}`} />
        {connected ? (
          <>Connected{syncMs != null ? ` · sync ${syncMs}ms` : ""}</>
        ) : (
          "Local · relay no conectado"
        )}
      </span>
      <span
        className={itemClass}
        title={inactive ? collab.statusBarTitle : undefined}
        data-collab-inactive={inactive || undefined}
      >
        {collaborators} {collaborators === 1 ? "collaborator" : "collaborators"}
      </span>
      <span className="statusbar-shortcuts">
        <kbd>{modKey}T</kbd> new · <kbd>{modKey}1-4</kbd> focus · <kbd>{modKey}{shiftKey}M</kbd> maximize
      </span>
    </footer>
  );
}
