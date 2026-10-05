import { useEffect, useRef, useState } from "react";

import { VscTerminal } from "react-icons/vsc";

import { agentInfo } from "../agents";
import { Check, ChevronDown, ChevronsUpDown, Logo, Plus, Search, Sliders } from "../icons";
import {
  localUser,
  sessionSummary,
  type PaneMeta,
  type PaneStatus,
  type Workspace,
} from "../model";
import { modKey } from "../shortcuts";
import { IconButton } from "./Button";
import { Panel } from "./Panel";
import { TerminalIcon } from "./TerminalIcon";

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
            <Logo />
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
              >
                <span className={`dot dot--${summary.tone}`} />
                <span className="session-text">
                  <span className="session-name">{s.name}</span>
                  <span className="session-meta">{summary.text}</span>
                </span>
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
                    const agent = m?.agent ?? null;
                    const label = agent
                      ? agentInfo(agent).name
                      : (m?.shellName ?? `Terminal ${i + 1}`);
                    const status = statuses[pane.id] ?? "starting";
                    const focused = isActive && props.focusedPaneId === pane.id;
                    return (
                      <li key={pane.id}>
                        <button
                          type="button"
                          className={`thread-item ${focused ? "thread-item--focused" : ""}`}
                          title={label}
                          onClick={() => props.onSelectTerminal(s.id, pane.id)}
                        >
                          <TerminalIcon agent={agent} shellName={m?.shellName ?? ""} size={14} />
                          <span className="thread-label">{label}</span>
                          <span className={`dot dot--${status}`} />
                        </button>
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

      <div className="user">
        <span className="avatar avatar--me">{localUser.initials}</span>
        <span className="user-text">
          <span className="user-name">{localUser.name}</span>
          <span className="user-status">
            <span className="dot dot--done" /> Local
          </span>
        </span>
        <ChevronsUpDown />
        <IconButton icon={<Sliders />} title="Settings" />
      </div>
    </aside>
  );
}
