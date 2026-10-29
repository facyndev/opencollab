import { useEffect, useRef, useState } from "react";
import { VscChevronRight, VscCopy, VscFolder, VscFolderOpened } from "react-icons/vsc";

import { Check, ChevronsUpDown, PopoverMenu, Search, joinPath, parentDirectories } from "@opencollab/ui";
import { listSubdirectories } from "../services/terminalApi";
import { copyTextToClipboard } from "../services/terminalClipboard";

type Props = {
  cwd: string;
  /// Motivo por el que no se puede cambiar de carpeta ahora (p. ej. corre un agente).
  disabledReason: string | null;
  onNavigate: (path: string) => void;
};

/// Con más subcarpetas que esto se muestra un filtro.
const FILTER_FROM = 8;
const COPIED_FEEDBACK_MS = 1500;

type Subdirs = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; names: string[] };

/// Ruta del header de una terminal: menú para ir hacia atrás (`..`, directorios
/// padre) o hacia adelante (subcarpetas), y acción para copiar la ruta actual.
export function CwdSwitcher({ cwd, disabledReason, onNavigate }: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [subdirs, setSubdirs] = useState<Subdirs>({ state: "loading" });
  const [filter, setFilter] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  const parents = parentDirectories(cwd);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const copyPath = async () => {
    const ok = await copyTextToClipboard(cwd);
    if (!ok) return;
    setCopied(true);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copyTimerRef.current = null;
    }, COPIED_FEEDBACK_MS);
  };

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
      <button
        type="button"
        className={`icon-btn cwd-copy-btn ${copied ? "cwd-copy-btn--copied" : ""}`}
        title={copied ? "Copied!" : `Copy path (${cwd})`}
        aria-label={copied ? "Copied!" : "Copy path"}
        onClick={() => void copyPath()}
      >
        {copied ? <Check /> : <VscCopy />}
      </button>

      <PopoverMenu open={open} onClose={() => setOpen(false)} anchorRef={buttonRef} align="left">
        <div className="cwd-item cwd-item--current" role="menuitem" aria-disabled="true">
          <VscFolderOpened />
          <span className="cwd-item-path">{cwd}</span>
          <span className="ws-check">
            <Check />
          </span>
        </div>
        <button
          type="button"
          role="menuitem"
          className="cwd-item"
          onClick={() => void copyPath()}
        >
          {copied ? <Check /> : <VscCopy />}
          <span className="cwd-item-label">{copied ? "Copied!" : "Copy path"}</span>
        </button>

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
      </PopoverMenu>
    </>
  );
}
