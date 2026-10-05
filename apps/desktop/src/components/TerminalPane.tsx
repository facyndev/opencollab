import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { agentInfo, type AgentId } from "../agents";
import { cdCommand, parseOsc7 } from "../cwd";
import { Close, Maximize, Minus } from "../icons";
import { localUser, statusLabel, type PaneMeta, type PaneStatus } from "../model";
import { IconButton } from "./Button";
import { CwdSwitcher } from "./CwdSwitcher";
import { NewTerminalMenu } from "./NewTerminalMenu";
import { Panel } from "./Panel";
import { TerminalIcon } from "./TerminalIcon";
import {
  attachTerminal,
  closeTerminal,
  openShell,
  resizeTerminal,
  writeTerminal,
} from "../terminalApi";

type Props = {
  paneId: string;
  /// Carpeta en la que arranca la shell (`null` = la por defecto).
  initialCwd: string | null;
  focused: boolean;
  minimized: boolean;
  maximized: boolean;
  /// Oculto (otra sesión activa u otro panel en foco): sigue montado para no perder el PTY.
  hidden: boolean;
  /// Posición visual en la grilla (propiedad CSS `order`).
  order: number;
  dragging: boolean;
  draggable: boolean;
  registerEl: (paneId: string, el: HTMLElement | null) => void;
  onDragStart: (paneId: string, e: React.PointerEvent) => void;
  onStatus: (paneId: string, status: PaneStatus) => void;
  /// Qué corre en la terminal, para mostrarlo también en el sidebar.
  onMeta: (paneId: string, meta: PaneMeta) => void;
  onFocus: () => void;
  onToggleMinimize: () => void;
  onToggleMaximize: () => void;
  onClosed: () => void;
  /// Abrir otra terminal al lado de esta (`cwd` = carpeta inicial, `null` = la por defecto).
  onNewTerminal: (cwd: string | null) => void;
};

/// Una celda de la grilla: una instancia de xterm.js conectada a un PTY del núcleo.
export function TerminalPane(props: Props) {
  const { paneId, initialCwd, onStatus, onMeta } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  /// Evita cerrar dos veces: el ✕ mata el PTY y eso también dispara `terminal-exit`.
  const closingRef = useRef(false);
  /// `close` cambia en cada render; el listener de salida (registrado una vez) usa la última.
  const closeRef = useRef<() => Promise<void>>(async () => {});
  const [info, setInfo] = useState<{ name: string; cwd: string | null } | null>(null);
  /// El primero es el agente principal de la terminal; los siguientes son los que
  /// ese agente tiene anidados.
  const [agents, setAgents] = useState<AgentId[]>([]);
  const agent = agents[0] ?? null;
  /// Directorio actual, según lo reporta la shell con OSC 7 en cada prompt.
  const [cwd, setCwd] = useState<string | null>(null);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [status, setStatus] = useState<PaneStatus>("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => onStatus(paneId, status), [paneId, status, onStatus]);
  useEffect(
    () => onMeta(paneId, { shellName: info?.name ?? null, agents, cwd, terminalId }),
    [paneId, info?.name, agents, cwd, terminalId, onMeta],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      theme: {
        background: "#0b0b0d",
        foreground: "#e4e4e7",
        cursor: "#a78bfa",
        selectionBackground: "#3b2f6b",
      },
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // fit() con el contenedor oculto (0x0) deja la terminal en 1 columna.
    const fitIfVisible = () => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      fit.fit();
      const id = terminalIdRef.current;
      if (id) void resizeTerminal(id, term.cols, term.rows);
    };
    fitIfVisible();

    const osc7 = term.parser.registerOscHandler(7, (data) => {
      const path = parseOsc7(data);
      if (path) setCwd(path);
      return true;
    });

    let disposed = false;
    let detach: (() => void) | null = null;

    // La carpeta inicial solo importa al crear el PTY: no se reabre si cambia.
    openShell(term.cols, term.rows, initialCwd)
      .then((opened) => {
        if (disposed) {
          void closeTerminal(opened.terminalId);
          return;
        }
        terminalIdRef.current = opened.terminalId;
        setTerminalId(opened.terminalId);
        setInfo({ name: opened.name, cwd: opened.cwd });
        setCwd((current) => current ?? opened.cwd);
        detach = attachTerminal(opened.terminalId, {
          onOutput: (data) => term.write(data),
          // La shell terminó sola (p. ej. `exit`): se cierra igual que con el ✕.
          onExit: () => {
            setStatus("done");
            setAgents([]);
            void closeRef.current();
          },
          onAgent: setAgents,
        });
        setStatus((s) => (s === "done" ? s : "running"));
      })
      .catch((e) => {
        setStatus("failed");
        setError(String(e));
      });

    // xterm.js también contesta las consultas de ConPTY (p. ej. ESC[6n) por acá.
    const input = term.onData((data) => {
      const id = terminalIdRef.current;
      if (id) void writeTerminal(id, data);
    });

    const observer = new ResizeObserver(fitIfVisible);
    observer.observe(container);

    return () => {
      disposed = true;
      osc7.dispose();
      observer.disconnect();
      input.dispose();
      detach?.();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (props.focused && !props.hidden && !props.minimized) termRef.current?.focus();
  }, [props.focused, props.hidden, props.minimized]);

  const close = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    const id = terminalIdRef.current;
    if (id) {
      try {
        await closeTerminal(id);
      } catch (e) {
        // Si el núcleo ya no la tiene (p. ej. terminó sola), igual se quita de la grilla.
        console.warn("close_terminal:", e);
      }
    }
    props.onClosed();
  };
  closeRef.current = close;

  // Si corre un agente conocido, el panel lo muestra a él en vez de a la shell.
  const detected = agent ? agentInfo(agent) : null;
  const name = detected?.name ?? info?.name ?? "Terminal";
  const shellName = info?.name ?? "shell";

  // Cambiar de carpeta es escribirle un `cd` a la shell: con un agente corriendo
  // ese texto le llegaría al agente, así que se desactiva.
  const cwdDisabledReason =
    status !== "running"
      ? "La terminal no está corriendo"
      : detected
        ? `Salí de ${detected.name} para cambiar de carpeta`
        : null;

  const navigate = (path: string) => {
    const id = terminalIdRef.current;
    if (!id) return;
    void writeTerminal(id, cdCommand(shellName, path));
    termRef.current?.focus();
  };
  const classes = [
    "pane",
    props.focused && "pane--focused",
    props.minimized && "pane--minimized",
    props.maximized && "pane--maximized",
    props.dragging && "pane--dragging",
  ]
    .filter(Boolean)
    .join(" ");

  const header = (
      <header
        className={`pane-header ${props.draggable ? "pane-header--draggable" : ""}`}
        onPointerDown={(e) => props.onDragStart(paneId, e)}
      >
        <TerminalIcon agent={agent} shellName={info?.name ?? ""} />
        <span className="pane-name" title={detected ? `${name} · en ${shellName}` : undefined}>
          {name}
        </span>
        {cwd && (
          <span className="pane-cwd">
            <CwdSwitcher cwd={cwd} disabledReason={cwdDisabledReason} onNavigate={navigate} />
          </span>
        )}
        <span className={`pane-status pane-status--${status}`} title={error ?? undefined}>
          <span className={`dot dot--${status}`} />
          {statusLabel[status]}
        </span>
        <span className="avatar avatar--sm avatar--me" title={`${localUser.name} (host)`}>
          {localUser.initials}
        </span>
        <span className="pane-controls">
          <NewTerminalMenu cwd={cwd} onOpen={props.onNewTerminal} />
          <IconButton icon={<Minus />} title="Minimize" onClick={props.onToggleMinimize} />
          <IconButton icon={<Maximize />} title="Maximize" onClick={props.onToggleMaximize} />
          <IconButton icon={<Close />} title="Close" onClick={() => void close()} />
        </span>
      </header>
  );

  return (
    <Panel
      ref={(el) => props.registerEl(paneId, el)}
      className={classes}
      hidden={props.hidden}
      style={{ order: props.order }}
      // pointerdown y no mousedown: el arrastre cancela los eventos de mouse del header.
      onPointerDown={props.onFocus}
      header={header}
      bodyRef={containerRef}
      bodyClassName="pane-body"
    />
  );
}
