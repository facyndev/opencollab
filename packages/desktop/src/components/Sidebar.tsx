import { useEffect, useRef, useState } from "react";

import { VscTerminal } from "react-icons/vsc";

import { agentInfo } from "../agents";
import { opencollabLogoRounded } from "../assets/brand";
import { initialsOf, type AuthState } from "../auth";
import { Check, ChevronDown, ChevronsUpDown, Plus, Search, SignOut } from "../icons";
import {
  sessionSummary,
  type PaneMeta,
  type PaneStatus,
  type Workspace,
} from "../model";
import { modKey } from "../shortcuts";
import { Button, IconButton } from "./Button";
import { Panel } from "./Panel";
import { TerminalIcon } from "./TerminalIcon";
import { describeAgent } from "../agentState";
import { ThreadBranch, ThreadMeta, ThreadState } from "./ThreadMeta";

type Props = {
  workspaces: Workspace[];
  activeWorkspace: Workspace;
  activeSessionId: string;
  focusedPaneId: string | null;
  statuses: Record<string, PaneStatus>;
  meta: Record<string, PaneMeta>;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onSelectWorkspace: (id: string) => void;
  onCreateWorkspace: () => void;
  onSelectSession: (id: string) => void;
  onSelectTerminal: (sessionId: string, paneId: string) => void;
  onCreateSession: () => void;
  auth: AuthState;
  authBusy: boolean;
  authError: string | null;
  loginUrl: string | null;
  onSignIn: () => void;
  onCancelLogin: () => void;
  onSignOut: () => void;
};

export function Sidebar(props: Props) {
  const { workspaces, activeWorkspace, activeSessionId, statuses, meta } = props;
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [query, setQuery] = useState("");
  const switcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!switcherOpen) return;
    const close = (e: MouseEvent) => {
      if (!switcherRef.current?.contains(e.target as Node)) setSwitcherOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [switcherOpen]);

  const sessions = activeWorkspace.sessions.filter((s) =>
    s.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <aside className="sidebar">
      <div className="ws-switcher" ref={switcherRef}>
        <button
          type="button"
          className="ws-current"
          aria-expanded={switcherOpen}
          onClick={() => setSwitcherOpen((o) => !o)}
        >
          <span className="ws-logo">
            <img src={opencollabLogoRounded} alt="OpenCollab" className="ws-logo-img" />
          </span>
          <span className="ws-text">
            <span className="ws-name">{activeWorkspace.name}</span>
            <span className="ws-meta">
              Workspace · {activeWorkspace.members} member{activeWorkspace.members === 1 ? "" : "s"}
            </span>
          </span>
          <ChevronDown />
        </button>

        {switcherOpen && (
          <div className="ws-menu" role="menu">
            <div className="ws-menu-title">Switch workspace</div>
            {workspaces.map((ws) => (
              <button
                key={ws.id}
                type="button"
                role="menuitem"
                className="ws-menu-item"
                onClick={() => {
                  props.onSelectWorkspace(ws.id);
                  setSwitcherOpen(false);
                }}
              >
                <span className="ws-initial">{ws.name.charAt(0).toUpperCase()}</span>
                <span className="ws-menu-name">{ws.name}</span>
                {ws.id === activeWorkspace.id && (
                  <span className="ws-check">
                    <Check />
                  </span>
                )}
              </button>
            ))}
            <div className="ws-menu-sep" />
            <button
              type="button"
              role="menuitem"
              className="ws-menu-item ws-menu-new"
              onClick={() => {
                props.onCreateWorkspace();
                setSwitcherOpen(false);
              }}
            >
              <Plus />
              <span>New workspace</span>
            </button>
          </div>
        )}
      </div>

      <label className="search">
        <Search />
        <input
          ref={props.searchRef}
          placeholder="Search sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <kbd>{modKey}K</kbd>
      </label>

      <div className="sessions-header">
        <span>Sessions</span>
        <IconButton icon={<Plus />} title="New session" onClick={props.onCreateSession} />
      </div>

      <nav className="sessions">
        {sessions.map((s) => {
          const summary = sessionSummary(s.panes, statuses);
          const isActive = s.id === activeSessionId;
          const header = (
              <button
                type="button"
                className={`session ${isActive ? "session--active" : ""}`}
                onClick={() => props.onSelectSession(s.id)}
                title={summary.text}
              >
                <span className={`dot dot--${summary.tone}`} />
                <span className="session-name">{s.name}</span>
                <span className="session-count" title={`${s.panes.length} terminales`}>
                  <VscTerminal className="session-count-icon" aria-hidden="true" />
                  {s.panes.length}
                </span>
              </button>
          );

          // Mismo wrapper que el panel de una terminal; solo la sesión activa
          // muestra el marco.
          return (
            <Panel
              key={s.id}
              as="div"
              className="session-group"
              plain={!isActive}
              header={header}
              bodyClassName="thread-body"
            >
              {/* Hilo: las terminales de la sesión, en el mismo orden que la grilla. */}
              {s.panes.length > 0 ? (
                <ul className="thread">
                  {s.panes.map((pane, i) => {
                    const m = meta[pane.id];
                    const agents = m?.agents ?? [];
                    const agent = agents[0] ?? null;
                    const label = agent
                      ? agentInfo(agent).name
                      : (m?.shellName ?? `Terminal ${i + 1}`);
                    const status = statuses[pane.id] ?? "starting";
                    const focused = isActive && props.focusedPaneId === pane.id;
                    const agentState = agent ? (m?.agentState ?? null) : null;
                    const attention = agent ? !!m?.attention : false;
                    // Con un agente de estado conocido, el estado va junto al título
                    // y reemplaza al punto.
                    const { tone, label: stateLabel } = describeAgent(agentState, attention);
                    const branch = m?.branch ?? null;
                    const select = () => props.onSelectTerminal(s.id, pane.id);
                    const hasUptime = agent !== null && m?.startedAt != null;
                    return (
                      <li key={pane.id}>
                        <button
                          type="button"
                          className={`thread-item ${focused ? "thread-item--focused" : ""} ${
                            hasUptime ? "thread-item--has-uptime" : ""
                          }`}
                          title={label}
                          onClick={select}
                        >
                          <TerminalIcon agent={agent} shellName={m?.shellName ?? ""} size={14} />
                          <span className="thread-heading">
                            <span className="thread-label">{label}</span>
                            <ThreadState tone={tone} label={stateLabel} />
                          </span>
                          {tone === "none" && <span className={`dot dot--${status}`} />}
                        </button>
                        {/* Línea secundaria agnóstica: herramienta y tiempo corriendo
                            (solo con agente detectado). */}
                        <ThreadMeta
                          agent={agentState}
                          attention={attention}
                          startedAt={agent ? (m?.startedAt ?? null) : null}
                        />
                        {/* Hijo del hilo: la rama de git (cualquier terminal en un repo);
                            abre la misma terminal. Los agentes anidados no se listan. */}
                        {branch ? (
                          <ul className="thread thread--sub">
                            <ThreadBranch branch={branch} onClick={select} />
                          </ul>
                        ) : undefined}
                      </li>
                    );
                  })}
                </ul>
              ) : undefined}
            </Panel>
          );
        })}
        {sessions.length === 0 && <p className="sessions-empty">No sessions match.</p>}
      </nav>

      {/* Cuenta del desktop: anónima ofrece el login vía la web; autenticada
          muestra el usuario real (antes era la cuenta local fija, oculta). */}
      <AuthCard
        auth={props.auth}
        busy={props.authBusy}
        error={props.authError}
        loginUrl={props.loginUrl}
        onSignIn={props.onSignIn}
        onCancelLogin={props.onCancelLogin}
        onSignOut={props.onSignOut}
      />
    </aside>
  );
}

function AuthCard(props: {
  auth: AuthState;
  busy: boolean;
  error: string | null;
  loginUrl: string | null;
  onSignIn: () => void;
  onCancelLogin: () => void;
  onSignOut: () => void;
}) {
  const { auth, busy } = props;
  if (auth.status === "authenticated") {
    return (
      <div className="user">
        <span className="avatar avatar--me">{initialsOf(auth.user)}</span>
        <span className="user-text">
          <span className="user-name">{auth.user.displayName || auth.user.username}</span>
          <span className="user-status">
            <span className="dot dot--done" /> Online
          </span>
        </span>
        <IconButton icon={<SignOut />} title="Sign out" onClick={props.onSignOut} />
      </div>
    );
  }
  return (
    <div className="user user--auth">
      <span className="user-text">
        <span className="user-name">
          {auth.status === "unknown" ? "Loading…" : busy ? "Waiting for browser…" : "Not signed in"}
        </span>
        {props.error ? (
          <span className="user-status" role="alert">
            {props.error}
          </span>
        ) : (
          <span className="user-status">
            {busy ? "Finish sign-in in your browser" : "Sign in to collaborate"}
          </span>
        )}
      </span>
      {busy ? (
        <Button onClick={props.onCancelLogin}>Cancel</Button>
      ) : (
        <Button
          variant="primary"
          onClick={props.onSignIn}
          disabled={auth.status === "unknown"}
          title="Opens the browser to sign in"
        >
          Sign in
        </Button>
      )}
      {busy && props.loginUrl ? (
        <a className="user-link" href={props.loginUrl} target="_blank" rel="noreferrer">
          Browser didn&apos;t open? Open manually
        </a>
      ) : undefined}
      <ChevronsUpDown />
    </div>
  );
}
