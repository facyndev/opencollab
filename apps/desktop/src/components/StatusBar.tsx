import { modKey, shiftKey } from "../shortcuts";

type Props = { terminals: number; live: number };

export function StatusBar({ terminals, live }: Props) {
  return (
    <footer className="statusbar">
      <span className="statusbar-item">
        <span className="dot dot--idle" /> Local · relay no conectado
      </span>
      <span className="statusbar-item">
        {terminals} terminal{terminals === 1 ? "" : "s"} · {live} live
      </span>
      <span className="statusbar-item">1 collaborator</span>
      <span className="statusbar-shortcuts">
        <kbd>{modKey}T</kbd> new · <kbd>{modKey}{shiftKey}T</kbd> new here · <kbd>{modKey}1-4</kbd> focus · <kbd>{modKey}{shiftKey}M</kbd> maximize
      </span>
    </footer>
  );
}
