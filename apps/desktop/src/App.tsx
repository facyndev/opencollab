import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { opencollabLogoTransparent } from "./assets/brand";
import { Button } from "./components/Button";
import { Sidebar } from "./components/Sidebar";
import { Plus } from "./icons";
import { StatusBar } from "./components/StatusBar";
import { TerminalPane } from "./components/TerminalPane";
import { TopBar } from "./components/TopBar";
import {
  insertPaneAfter,
  newPane,
  newSession,
  newWorkspace,
  swapPanes,
  type Layout,
  type PaneMeta,
  type PaneStatus,
  type Session,
  type Workspace,
} from "./model";
import { isMod } from "./shortcuts";
import { useCollabStatus } from "./useCollabStatus";
import { usePaneDrag } from "./usePaneDrag";

function initialWorkspaces(): Workspace[] {
  const ws = newWorkspace("OpenCollab");
  ws.sessions[0].panes.push(newPane());
  return [ws];
}

export function App() {
  const collab = useCollabStatus();
  const [workspaces, setWorkspaces] = useState<Workspace[]>(initialWorkspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() => workspaces[0].id);
  // Sesión activa recordada por workspace, para volver a la misma al cambiar.
  const [activeSessionByWs, setActiveSessionByWs] = useState<Record<string, string>>(() => ({
    [workspaces[0].id]: workspaces[0].sessions[0].id,
  }));
  const [layout, setLayout] = useState<Layout>("grid");
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(
    () => workspaces[0].sessions[0].panes[0]?.id ?? null,
  );
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, PaneStatus>>({});
  const [meta, setMeta] = useState<Record<string, PaneMeta>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];
  const activeSession =
    activeWorkspace.sessions.find((s) => s.id === activeSessionByWs[activeWorkspace.id]) ??
    activeWorkspace.sessions[0];

  const updateSession = useCallback(
    (sessionId: string, update: (s: Session) => Session) =>
      setWorkspaces((list) =>
        list.map((ws) => ({
          ...ws,
          sessions: ws.sessions.map((s) => (s.id === sessionId ? update(s) : s)),
        })),
      ),
    [],
  );

  const onStatus = useCallback(
    (paneId: string, status: PaneStatus) => setStatuses((m) => ({ ...m, [paneId]: status })),
    [],
  );

  const onMeta = useCallback(
    (paneId: string, value: PaneMeta) => setMeta((m) => ({ ...m, [paneId]: value })),
    [],
  );

  /// Abre una terminal en la sesión activa. Si se abre desde otra (`fromPaneId`),
  /// va al lado de ella; `cwd` es la carpeta inicial (`null` = la por defecto).
  const addTerminal = useCallback(
    (cwd: string | null = null, fromPaneId: string | null = null) => {
      const pane = newPane(cwd);
      updateSession(activeSession.id, (s) => ({
        ...s,
        panes: insertPaneAfter(s.panes, fromPaneId, pane),
      }));
      setFocusedPaneId(pane.id);
      setMaximizedPaneId(null);
    },
    [activeSession.id, updateSession],
  );

  const removePane = (sessionId: string, paneId: string) => {
    updateSession(sessionId, (s) => ({ ...s, panes: s.panes.filter((p) => p.id !== paneId) }));
    setStatuses(({ [paneId]: _removed, ...rest }) => rest);
    setMeta(({ [paneId]: _removed, ...rest }) => rest);
    if (maximizedPaneId === paneId) setMaximizedPaneId(null);
    if (focusedPaneId === paneId) setFocusedPaneId(null);
  };

  const selectSession = (sessionId: string) => {
    setActiveSessionByWs((m) => ({ ...m, [activeWorkspace.id]: sessionId }));
    setMaximizedPaneId(null);
    const session = activeWorkspace.sessions.find((s) => s.id === sessionId);
    setFocusedPaneId(session?.panes[0]?.id ?? null);
  };

  /// Clic en una terminal del hilo del sidebar: ir a su sesión y enfocarla.
  const selectTerminal = (sessionId: string, paneId: string) => {
    setActiveSessionByWs((m) => ({ ...m, [activeWorkspace.id]: sessionId }));
    setFocusedPaneId(paneId);
    // Si había un panel maximizado, pasar a mostrar este.
    if (maximizedPaneId) setMaximizedPaneId(paneId);
    updateSession(sessionId, (s) => ({
      ...s,
      panes: s.panes.map((p) => (p.id === paneId ? { ...p, minimized: false } : p)),
    }));
  };

  const createSession = () => {
    const session = newSession(`Sesión ${activeWorkspace.sessions.length + 1}`);
    setWorkspaces((list) =>
      list.map((ws) =>
        ws.id === activeWorkspace.id ? { ...ws, sessions: [...ws.sessions, session] } : ws,
      ),
    );
    setActiveSessionByWs((m) => ({ ...m, [activeWorkspace.id]: session.id }));
    setFocusedPaneId(null);
  };

  const createWorkspace = () => {
    const ws = newWorkspace(`Workspace ${workspaces.length + 1}`);
    setWorkspaces((list) => [...list, ws]);
    setActiveWorkspaceId(ws.id);
    setActiveSessionByWs((m) => ({ ...m, [ws.id]: ws.sessions[0].id }));
    setFocusedPaneId(null);
  };

  const toggleMaximize = useCallback(
    (paneId: string | null) => setMaximizedPaneId((m) => (m === paneId ? null : paneId)),
    [],
  );

  // Atajos globales. En fase de captura para que xterm no se quede con ellos.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isMod(e)) return;
      const key = e.key.toLowerCase();
      let handled = true;
      if (key === "t" && !e.shiftKey) addTerminal();
      // En la carpeta de la terminal enfocada (si se conoce), al lado de ella.
      else if (key === "t" && e.shiftKey)
        addTerminal(focusedPaneId ? (meta[focusedPaneId]?.cwd ?? null) : null, focusedPaneId);
      else if (key === "k" && !e.shiftKey) searchRef.current?.focus();
      else if (key === "m" && e.shiftKey) toggleMaximize(focusedPaneId);
      else if (/^[1-4]$/.test(key)) {
        const pane = activeSession.panes[Number(key) - 1];
        if (pane) {
          setFocusedPaneId(pane.id);
          if (maximizedPaneId) setMaximizedPaneId(pane.id);
        }
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [addTerminal, toggleMaximize, focusedPaneId, maximizedPaneId, activeSession.panes, meta]);

  const soloPaneId =
    maximizedPaneId ?? (layout === "single" ? (focusedPaneId ?? activeSession.panes[0]?.id) : null);

  const activeOrder = useMemo(() => activeSession.panes.map((p) => p.id), [activeSession.panes]);
  const activeSessionId = activeSession.id;
  const onSwap = useCallback(
    (a: string, b: string) =>
      updateSession(activeSessionId, (s) => ({ ...s, panes: swapPanes(s.panes, a, b) })),
    [activeSessionId, updateSession],
  );
  // Con un solo panel visible (maximizado / single) no hay con quién intercambiar.
  const canDrag = soloPaneId === null && activeSession.panes.length > 1;
  const { registerPane, startDrag, draggingId } = usePaneDrag({
    order: activeOrder,
    enabled: canDrag,
    onSwap,
  });

  // DOM en orden de creación (estable); la posición visual va por CSS `order`.
  const allPanes = useMemo(
    () =>
      workspaces
        .flatMap((ws) =>
          ws.sessions.flatMap((session) =>
            session.panes.map((pane, index) => ({ session, pane, index })),
          ),
        )
        .sort((x, y) => x.pane.seq - y.pane.seq),
    [workspaces],
  );

  const totals = useMemo(() => {
    const panes = activeSession.panes;
    const live = panes.filter((p) => {
      const s = statuses[p.id] ?? "starting";
      return s === "running" || s === "starting";
    }).length;
    return { terminals: panes.length, live };
  }, [activeSession.panes, statuses]);

  return (
    <div className="app">
      <Sidebar
        workspaces={workspaces}
        activeWorkspace={activeWorkspace}
        activeSessionId={activeSession.id}
        focusedPaneId={focusedPaneId}
        statuses={statuses}
        meta={meta}
        onSelectTerminal={selectTerminal}
        searchRef={searchRef}
        onSelectWorkspace={(id) => {
          setActiveWorkspaceId(id);
          setMaximizedPaneId(null);
        }}
        onCreateWorkspace={createWorkspace}
        onSelectSession={selectSession}
        onCreateSession={createSession}
      />

      <div className="main">
        <TopBar
          workspaceName={activeWorkspace.name}
          sessionName={activeSession.name}
          layout={layout}
          onLayout={(l) => {
            setLayout(l);
            setMaximizedPaneId(null);
          }}
          onNewTerminal={() => addTerminal()}
        />

        <main
          className={[
            "grid",
            `grid--${layout}`,
            soloPaneId && "grid--solo",
            draggingId && "grid--dragging",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{ "--cols": Math.min(2, Math.max(1, totals.terminals)) } as React.CSSProperties}
        >
          {/* Todas las terminales quedan montadas; las de otras sesiones solo se ocultan. */}
          {allPanes.map(({ session, pane, index }) => {
            const inActiveSession = session.id === activeSession.id;
            return (
              <TerminalPane
                key={pane.id}
                paneId={pane.id}
                initialCwd={pane.initialCwd}
                order={index}
                focused={focusedPaneId === pane.id}
                minimized={pane.minimized && soloPaneId !== pane.id}
                maximized={soloPaneId === pane.id}
                hidden={!inActiveSession || (soloPaneId !== null && soloPaneId !== pane.id)}
                dragging={draggingId === pane.id}
                draggable={canDrag && inActiveSession}
                registerEl={registerPane}
                onDragStart={startDrag}
                onStatus={onStatus}
                onMeta={onMeta}
                onFocus={() => setFocusedPaneId(pane.id)}
                onToggleMinimize={() =>
                  updateSession(session.id, (s) => ({
                    ...s,
                    panes: s.panes.map((p) =>
                      p.id === pane.id ? { ...p, minimized: !p.minimized } : p,
                    ),
                  }))
                }
                onToggleMaximize={() => toggleMaximize(pane.id)}
                onClosed={() => removePane(session.id, pane.id)}
                onNewTerminal={(cwd) => addTerminal(cwd, pane.id)}
              />
            );
          })}

          {activeSession.panes.length === 0 && (
            <div className="grid-empty">
              <img src={opencollabLogoTransparent} alt="OpenCollab" className="grid-empty-logo" />
              <p>Esta sesión no tiene terminales.</p>
              <Button variant="primary" icon={<Plus />} onClick={() => addTerminal()}>
                New terminal
              </Button>
            </div>
          )}
        </main>

        <StatusBar connected={collab.connected} syncMs={collab.syncMs} collaborators={collab.collaborators} />
      </div>
    </div>
  );
}
