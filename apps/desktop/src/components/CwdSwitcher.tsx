import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { VscChevronRight, VscFolder, VscFolderOpened } from "react-icons/vsc";

import { joinPath, parentDirectories } from "../cwd";
import { Check, ChevronsUpDown, Search } from "../icons";
import { listSubdirectories } from "../terminalApi";

type Props = {
  cwd: string;
  /// Motivo por el que no se puede cambiar de carpeta ahora (p. ej. corre un agente).
  disabledReason: string | null;
  onNavigate: (path: string) => void;
};

/// Con más subcarpetas que esto se muestra un filtro.
const FILTER_FROM = 8;

type Subdirs = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; names: string[] };

/// Ruta del header de una terminal: menú para ir hacia atrás (`..`, directorios
/// padre) o hacia adelante (subcarpetas).
export function CwdSwitcher({ cwd, disabledReason, onNavigate }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [subdirs, setSubdirs] = useState<Subdirs>({ state: "loading" });
  const [filter, setFilter] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const parents = parentDirectories(cwd);

  // El panel recorta su contenido (overflow: hidden): el menú va en un portal
  // con posición fija, debajo del botón.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    setPosition({ left: r.left, top: r.bottom + 4 });
  }, [open]);

  // Las subcarpetas se piden al abrir: el disco pudo cambiar desde la última vez.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFilter("");
    setSubdirs({ state: "loading" });
    listSubdirectories(cwd)
      .then((names) => !cancelled && setSubdirs({ state: "ok", names }))
      .catch((e) => !cancelled && setSubdirs({ state: "error", message: String(e) }));
    return () => {
      cancelled = true;
    };
  }, [open, cwd]);

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

  // Si la shell deja de estar disponible (arranca un agente), cerrar el menú.
  useEffect(() => {
    if (disabledReason) setOpen(false);
  }, [disabledReason]);

  const go = (path: string) => {
    setOpen(false);
    onNavigate(path);
  };

  const visible =
    subdirs.state === "ok"
      ? subdirs.names.filter((n) => n.toLowerCase().includes(filter.trim().toLowerCase()))
      : [];

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="cwd-button"
        title={disabledReason ?? `${cwd} — cambiar de directorio`}
        disabled={disabledReason !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="cwd-path">{cwd}</span>
        <ChevronsUpDown />
      </button>

      {open &&
        position &&
        createPortal(
          <div className="cwd-menu" role="menu" ref={menuRef} style={position}>
            <div className="cwd-item cwd-item--current" role="menuitem" aria-disabled="true">
              <VscFolderOpened />
              <span className="cwd-item-path">{cwd}</span>
              <span className="ws-check">
                <Check />
              </span>
            </div>

            {/* Hacia adelante: subcarpetas del directorio actual. */}
            <div className="ws-menu-sep" />
            <div className="ws-menu-title">Subdirectories</div>
            {subdirs.state === "ok" && subdirs.names.length > FILTER_FROM && (
              <label className="cwd-filter">
                <Search />
                <input
                  autoFocus
                  placeholder="Filtrar carpetas"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && visible.length > 0) go(joinPath(cwd, visible[0]));
                  }}
                />
              </label>
            )}
            <div className="cwd-scroll">
              {subdirs.state === "loading" && <div className="cwd-empty">Cargando…</div>}
              {subdirs.state === "error" && (
                <div className="cwd-empty" title={subdirs.message}>
                  No se pudo leer la carpeta
                </div>
              )}
              {subdirs.state === "ok" && visible.length === 0 && (
                <div className="cwd-empty">
                  {subdirs.names.length === 0 ? "Sin subcarpetas" : "Sin coincidencias"}
                </div>
              )}
              {visible.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="menuitem"
                  className="cwd-item"
                  onClick={() => go(joinPath(cwd, name))}
                >
                  <VscFolder />
                  <span className="cwd-item-path">{name}</span>
                  <VscChevronRight className="cwd-item-forward" />
                </button>
              ))}
            </div>

            {/* Hacia atrás: `..` y todos los directorios padre. */}
            {parents.length > 0 && (
              <>
                <div className="ws-menu-sep" />
                <div className="ws-menu-title">Parent directories</div>
                <button type="button" role="menuitem" className="cwd-item" onClick={() => go(parents[0])}>
                  <VscFolder />
                  <span className="cwd-item-path">..</span>
                  <span className="cwd-item-hint">{parents[0]}</span>
                </button>
                {parents.map((path) => (
                  <button
                    key={path}
                    type="button"
                    role="menuitem"
                    className="cwd-item"
                    onClick={() => go(path)}
                  >
                    <VscFolder />
                    <span className="cwd-item-path">{path}</span>
                  </button>
                ))}
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
