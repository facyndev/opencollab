import { LayoutColumns, LayoutGrid, LayoutSingle, Plus, UserPlus } from "../icons";
import { localUser, type Layout } from "../model";
import { Button } from "./Button";

type Props = {
  workspaceName: string;
  sessionName: string;
  layout: Layout;
  onLayout: (layout: Layout) => void;
  onNewTerminal: () => void;
};

const layouts: { id: Layout; label: string; icon: () => React.JSX.Element }[] = [
  { id: "grid", label: "Grid", icon: LayoutGrid },
  { id: "columns", label: "Columns", icon: LayoutColumns },
  { id: "single", label: "Single", icon: LayoutSingle },
];

export function TopBar(props: Props) {
  return (
    <header className="topbar">
      <nav className="breadcrumb">
        <span className="crumb-muted">{props.workspaceName}</span>
        <span className="crumb-sep">/</span>
        <strong>{props.sessionName}</strong>
      </nav>

      <div className="topbar-actions">
        <div className="avatars" title="Participantes conectados">
          <span className="avatar avatar--me">{localUser.initials}</span>
        </div>
        <Button icon={<UserPlus />} disabled title="Requiere el relay: todavía no está conectado">
          Invite
        </Button>
        <div className="segmented" role="group" aria-label="Layout">
          {layouts.map(({ id, label, icon: LayoutIcon }) => (
            <button
              key={id}
              type="button"
              title={label}
              aria-pressed={props.layout === id}
              className={props.layout === id ? "is-active" : ""}
              onClick={() => props.onLayout(id)}
            >
              <LayoutIcon />
            </button>
          ))}
        </div>
        <Button variant="primary" icon={<Plus />} onClick={props.onNewTerminal}>
          New terminal
        </Button>
      </div>
    </header>
  );
}
