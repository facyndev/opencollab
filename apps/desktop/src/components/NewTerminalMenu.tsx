import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { VscFolderOpened, VscHome } from "react-icons/vsc";

import { Plus } from "../icons";
import { modKey, shiftKey } from "../shortcuts";

type Props = {
  /// Carpeta actual de la terminal (`null` si todavía no se conoce).
  cwd: string | null;
  /// `cwd` = carpeta inicial de la terminal nueva; `null` = la por defecto.
  onOpen: (cwd: string | null) => void;
};

/// Botón del header de una terminal para abrir otra: en la misma carpeta o en la por defecto.
export function NewTerminalMenu({ cwd, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ right: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Mismo motivo que en CwdSwitcher: el panel recorta (overflow: hidden), así que
  // el menú va en un portal con posición fija, alineado al borde derecho del botón.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    setPosition({ right: window.innerWidth - r.right, top: r.bottom + 4 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const choose = (dir: string | null) => {
    setOpen(false);
    onOpen(dir);
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

      {open &&
        position &&
        createPortal(
          <div className="cwd-menu new-terminal-menu" role="menu" ref={menuRef} style={position}>
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
          </div>,
          document.body,
        )}
    </>
  );
}
