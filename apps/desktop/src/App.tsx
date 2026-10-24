import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Button,
  Plus,
  Sidebar,
  StatusBar,
  TopBar,
  insertPaneAfter,
  isMod,
  newPane,
  newSession,
  newWorkspace,
  opencollabLogoTransparent,
  swapPanes,
  type AgentId,
  type Layout,
  type PaneMeta,
  type PaneStatus,
  type Session,
  type Workspace,
} from "@opencollab/ui";
import { CloudGate } from "./components/CloudGate";
import { TerminalPane } from "./components/TerminalPane";
import { Onboarding } from "./components/Onboarding";
import { SettingsDialog } from "./components/SettingsDialog";
import { useAuth, useCollabStatus, usePaneDrag } from "./hooks";
import { loadSnapshot, saveSnapshot, flushSnapshotSaves } from "./services/snapshot";
import {
  DEFAULT_STORAGE_CONFIG,
  loadStorageConfig,
  saveStorageConfig,
  type StorageConfig,
  type StorageMode,
} from "./services/storage";

function initialWorkspaces(): Workspace[] {
  const ws = newWorkspace("OpenCollab");
  ws.sessions[0].panes.push(newPane());
  return [ws];
}

export function App() {
  const collab = useCollabStatus();
  const auth = useAuth();
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
  const [focusAckSeq, setFocusAckSeq] = useState(0);
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, PaneStatus>>({});
  const [meta, setMeta] = useState<Record<string, PaneMeta>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const [storage, setStorage] = useState<StorageConfig | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  useEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceId;
  }, [activeWorkspaceId]);

  // La estructura arranca con el default y a los valores reemplaza el snapshot
  // guardado del núcleo (S5 del feature desktop-dual-storage): mientras carga,
  // todo lo que asume `workspaces[0]` sigue funcionando.
  const hydratedRef = useRef(false);
  // Descarta una carga que quedó en vuelo cuando ya empezó otra (cambio de
  // modo durante el arranque): su resultado pertenece a otro store.
  const hydrationGeneration = useRef(0);
  // La grilla cloud no se muestra hasta que el snapshot cloud terminó de
  // cargar: un default visible con persistencia apagada perdería mutaciones.
  const [hydrationReady, setHydrationReady] = useState(false);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const hydratingRef = useRef(false);
  // `applyStorage` hidrata el store nuevo directamente; este flag evita que el
  // efecto de boot lance una segunda carga para el mismo cambio.
  const skipHydrationEffect = useRef(false);

  /// Reemplaza la estructura y, si el workspace activo no existe en el store
  /// nuevo, reapunta la selección al primero (cambio local ↔ cloud).
  const adoptWorkspaces = useCallback((next: Workspace[]) => {
    setWorkspaces(next);
    if (next.length === 0) return;
    if (next.some((w) => w.id === activeWorkspaceIdRef.current)) return;
    const first = next[0];
    const firstSession = first.sessions[0];
    setActiveWorkspaceId(first.id);
    setActiveSessionByWs({ [first.id]: firstSession.id });
    setFocusedPaneId(firstSession.panes[0]?.id ?? null);
    setMaximizedPaneId(null);
  }, []);

  /// Carga el snapshot del store que el núcleo ya tiene seleccionado. En un
  /// cambio de modo, `resetWhenMissing` evita reenviar la estructura local al
  /// store vacío: T6 es quien migra, no un efecto implícito de T4.
  const hydrate = useCallback(
    async (resetWhenMissing = false) => {
      const generation = ++hydrationGeneration.current;
      hydratingRef.current = true;
      hydratedRef.current = false;
      setHydrationReady(false);
      setHydrationError(null);
      try {
        const loaded = await loadSnapshot();
        if (generation !== hydrationGeneration.current) return false;
        if (loaded && loaded.length > 0) adoptWorkspaces(loaded);
        else if (resetWhenMissing) adoptWorkspaces(initialWorkspaces());
        else setWorkspaces((current: Workspace[]) => [...current]);
        hydratedRef.current = true;
        setHydrationReady(true);
        return true;
      } catch (error) {
        if (generation !== hydrationGeneration.current) return false;
        // Error inesperado del núcleo al cargar: la persistencia queda apagada
        // para no pisar un snapshot que todavía puede ser válido. La cuarentena
        // de un archivo corrupto la resuelve el núcleo y llega como `null`, no
        // como rechazo, así que este camino nunca habilita el guardado.
        console.error("no se pudo cargar el snapshot de workspaces:", error);
        setHydrationError(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        if (generation === hydrationGeneration.current) hydratingRef.current = false;
      }
    },
    [adoptWorkspaces],
  );

  // Primero la configuración: el snapshot se carga recién cuando el núcleo ya
  // apunta al store elegido. Sin configuración (navegador/E2E viejo) entra en
  // local completo para no bloquear la app.
  useEffect(() => {
    let cancelled = false;
    void loadStorageConfig()
      .then((config) => {
        if (!cancelled) setStorage(config);
      })
      .catch((error) => {
        console.error("no se pudo cargar la configuración de almacenamiento:", error);
        if (!cancelled) setStorage({ ...DEFAULT_STORAGE_CONFIG, onboardingComplete: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // El snapshot cloud solo se carga con sesión. Al perder la sesión se apaga
  // la persistencia y se vuelve al gate de login; al recuperarla se recarga el
  // store cloud. Para local, una única carga alcanza.
  useEffect(() => {
    if (!storage?.onboardingComplete) return;
    if (storage.mode === "cloud" && auth.state.status !== "authenticated") {
      // Cancela una carga en vuelo: su resultado pertenece a una sesión que ya
      // no existe y no debe volver a habilitar el guardado.
      hydrationGeneration.current += 1;
      hydratingRef.current = false;
      hydratedRef.current = false;
      skipHydrationEffect.current = false;
      setHydrationReady(false);
      return;
    }
    if (skipHydrationEffect.current) {
      skipHydrationEffect.current = false;
      return;
    }
    if (hydrationReady || hydratingRef.current || hydrationError) return;
    void hydrate();
  }, [storage, auth.state.status, hydrate, hydrationReady, hydrationError]);

  /// Guarda el modo/base URL y recarga el store nuevo. `true` si el núcleo
  /// aceptó el cambio (cloud exige sesión y URL válida).
  const applyStorage = useCallback(
    async (mode: StorageMode, apiBaseUrl: string) => {
      setStorageBusy(true);
      setStorageError(null);
      const wasHydrated = hydratedRef.current;
      const wasReady = hydrationReady;
      // Nada nuevo se guarda mientras se cambia de store; lo ya encolado
      // termina en el store viejo antes de que el núcleo lo reemplace.
      hydratedRef.current = false;
      setHydrationReady(false);
      setHydrationError(null);
      try {
        await flushSnapshotSaves();
        const next = await saveStorageConfig(mode, apiBaseUrl);
        // El efecto de boot no debe lanzar una segunda carga: la de acá abajo
        // es la que corresponde a este cambio de store.
        skipHydrationEffect.current = true;
        setStorage(next);
        if (!(await hydrate(true))) {
          setStorageError("No se pudo cargar el almacenamiento seleccionado.");
          return;
        }
        setSettingsOpen(false);
      } catch (error) {
        hydratedRef.current = wasHydrated;
        setHydrationReady(wasReady);
        setStorageError(error instanceof Error ? error.message : String(error));
      } finally {
        setStorageBusy(false);
      }
    },
    [hydrate, hydrationReady],
  );

  const retryHydration = useCallback(() => {
    setHydrationError(null);
    void hydrate();
  }, [hydrate]);

  const useLocalStorage = useCallback(() => {
    if (!storage) return;
    void applyStorage("local", storage.apiBaseUrl);
  }, [applyStorage, storage]);

  // Persistencia en cada mutación de la estructura; la cola del servicio
  // (`saveSnapshot`) garantiza que dos guardados nunca se cruzan.
  useEffect(() => {
    if (!hydratedRef.current) return;
    void saveSnapshot(workspaces);
  }, [workspaces]);

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
    (cwd: string | null = null, fromPaneId: string | null = null, agent: AgentId | null = null) => {
      const pane = newPane(cwd, agent);
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
    setFocusAckSeq((n) => n + 1);
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

  if (!storage) {
    return <div className="boot">Loading…</div>;
  }

  if (!storage.onboardingComplete) {
    return (
      <Onboarding
        auth={auth.state}
        authBusy={auth.busy}
        authError={auth.error}
        loginUrl={auth.loginUrl}
        busy={storageBusy}
        error={storageError}
        onChoose={(mode) => void applyStorage(mode, storage.apiBaseUrl)}
        onSignIn={() => void auth.beginLogin()}
        onCancelLogin={auth.cancelLogin}
      />
    );
  }

  // Cloud sin sesión no monta la grilla: sin tokens, cada mutación se
  // descartaría en silencio. El login rearma el store y recién ahí se hidrata.
  if (storage.mode === "cloud") {
    if (auth.state.status === "unknown") {
      return <div className="boot">Loading…</div>;
    }
    if (auth.state.status !== "authenticated") {
      return (
        <CloudGate
          auth={auth.state}
          authBusy={auth.busy}
          authError={auth.error}
          loginUrl={auth.loginUrl}
          busy={storageBusy}
          error={hydrationError}
          onSignIn={() => void auth.beginLogin()}
          onCancelLogin={auth.cancelLogin}
          onSignOut={() => void auth.logout()}
          onRetry={retryHydration}
          onUseLocal={useLocalStorage}
        />
      );
    }
    if (!hydrationReady) {
      if (!hydrationError) {
        return <div className="boot">Loading your cloud workspace…</div>;
      }
      return (
        <CloudGate
          auth={auth.state}
          authBusy={auth.busy}
          authError={auth.error}
          loginUrl={auth.loginUrl}
          busy={storageBusy}
          error={hydrationError}
          onSignIn={() => void auth.beginLogin()}
          onCancelLogin={auth.cancelLogin}
          onSignOut={() => void auth.logout()}
          onRetry={retryHydration}
          onUseLocal={useLocalStorage}
        />
      );
    }
  }

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
        storageMode={storage.mode}
        auth={auth.state}
        authBusy={auth.busy}
        authError={auth.error}
        loginUrl={auth.loginUrl}
        onSignIn={() => void auth.beginLogin()}
        onCancelLogin={auth.cancelLogin}
        onSignOut={() => void auth.logout()}
      />

      <div className="main">
        <TopBar
          workspaceName={activeWorkspace.name}
          sessionName={activeSession.name}
          layout={layout}
          storageMode={storage.mode}
          onLayout={(l) => {
            setLayout(l);
            setMaximizedPaneId(null);
          }}
          onNewTerminal={() => addTerminal()}
          onOpenSettings={() => {
            setStorageError(null);
            setSettingsOpen(true);
          }}
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
                initialAgent={pane.agent}
                order={index}
                focused={focusedPaneId === pane.id}
                focusAckSeq={focusedPaneId === pane.id ? focusAckSeq : 0}
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
                onNewTerminal={(cwd, agent) => addTerminal(cwd, pane.id, agent ?? null)}
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

        <StatusBar
          connected={collab.connected}
          syncMs={collab.syncMs}
          collaborators={collab.collaborators}
          storageMode={storage.mode}
        />
      </div>

      {settingsOpen && (
        <SettingsDialog
          storage={storage}
          auth={auth.state}
          authBusy={auth.busy}
          authError={auth.error}
          loginUrl={auth.loginUrl}
          busy={storageBusy}
          error={storageError}
          onClose={() => setSettingsOpen(false)}
          onSave={(mode, apiBaseUrl) => void applyStorage(mode, apiBaseUrl)}
          onSignIn={() => void auth.beginLogin()}
          onCancelLogin={auth.cancelLogin}
        />
      )}
    </div>
  );
}
