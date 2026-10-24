import { useEffect, useRef, useState } from "react";
import { VscFolderOpened, VscHome } from "react-icons/vsc";

import {
  Plus,
  PopoverMenu,
  TerminalIcon,
  agentInfo,
  modKey,
  shiftKey,
  type AgentId,
} from "@opencollab/ui";
import { availableAgents } from "../services/terminalApi";

type Props = {
  /// Carpeta actual de la terminal (`null` si todavía no se conoce).
  cwd: string | null;
  /// `cwd` = carpeta inicial de la terminal nueva; `null` = la por defecto.
  /// `agent` = agente a ejecutar dentro de la shell; omitido = solo la shell.
  onOpen: (cwd: string | null, agent?: AgentId) => void;
};

/// Botón del header de una terminal para abrir otra: en la misma carpeta o en la
/// por defecto, o directamente un agente instalado (corre dentro de la shell).
export function NewTerminalMenu({ cwd, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentId[]>([]);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Se consulta al abrir por primera vez (el núcleo lo cachea en `availableAgents`).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void availableAgents().then((found) => !cancelled && setAgents(found));
    return () => {
      cancelled = true;
    };
  }, [open]);

  const choose = (dir: string | null, agent?: AgentId) => {
    setOpen(false);
    onOpen(dir, agent);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn new-terminal-btn"
        title="New terminal"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Plus />
      </button>

      <PopoverMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={buttonRef}
        align="right"
        className="new-terminal-menu"
      >
        <div className="ws-menu-title">New terminal</div>
        <button
          type="button"
          role="menuitem"
          className="cwd-item"
          disabled={!cwd}
          title={cwd ?? "La carpeta de esta terminal todavía no se conoce"}
          onClick={() => choose(cwd)}
        >
          <VscFolderOpened />
          <span className="new-terminal-label">In this folder</span>
          <span className="cwd-item-path cwd-item-hint">{cwd ?? "—"}</span>
          <kbd className="new-terminal-kbd">{`${modKey}${shiftKey}T`}</kbd>
        </button>
        <button type="button" role="menuitem" className="cwd-item" onClick={() => choose(null)}>
          <VscHome />
          <span className="new-terminal-label">In the default folder</span>
          <span className="cwd-item-path" />
          <kbd className="new-terminal-kbd">{`${modKey}T`}</kbd>
        </button>
        {agents.length > 0 && (
          <>
            <div className="ws-menu-title">Launch agent{cwd ? " here" : ""}</div>
            {agents.map((id) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                className="cwd-item new-terminal-agent"
                data-agent={id}
                title={
                  cwd
                    ? `${agentInfo(id).name} en ${cwd}`
                    : `${agentInfo(id).name} en la carpeta por defecto`
                }
                onClick={() => choose(cwd, id)}
              >
                <TerminalIcon agent={id} shellName="" size={14} />
                <span className="new-terminal-label">{agentInfo(id).name}</span>
                <span className="cwd-item-path" />
              </button>
            ))}
          </>
        )}
      </PopoverMenu>
    </>
  );
}
