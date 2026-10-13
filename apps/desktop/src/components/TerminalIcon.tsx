import type { IconType } from "react-icons";
import { VscTerminal, VscTerminalBash, VscTerminalCmd, VscTerminalPowershell } from "react-icons/vsc";

import { agentInfo, type AgentId } from "../agents";

/// Ícono de la shell cuando no corre ningún agente conocido.
function shellIcon(name: string): IconType {
  const n = name.toLowerCase();
  if (n.includes("powershell") || n === "pwsh") return VscTerminalPowershell;
  if (n === "cmd" || n.includes("command prompt")) return VscTerminalCmd;
  if (n.includes("bash") || n.includes("zsh") || n === "sh") return VscTerminalBash;
  return VscTerminal;
}

type Props = {
  /// Agente detectado en la terminal (`null` = solo la shell).
  agent: AgentId | null;
  shellName: string;
  /// Tamaño en px (cuadrado).
  size?: number;
};

/// Lo que corre en una terminal: el logo del agente detectado o, si no hay
/// ninguno, el ícono de la shell. Lo usan el header del panel y el sidebar.
export function TerminalIcon({ agent, shellName, size = 18 }: Props) {
  const box = { width: size, height: size };
  if (agent) {
    const info = agentInfo(agent);
    if (info.logo) {
      // Máscara en vez de <img>: el SVG aporta la forma y el color sale del token --text.
      return (
        <span
          className="terminal-icon terminal-icon--logo"
          role="img"
          aria-label={info.name}
          style={{ ...box, "--logo": `url("${info.logo}")` } as React.CSSProperties}
        />
      );
    }
    return <span className="pane-badge">{info.badge}</span>;
  }
  const Icon = shellIcon(shellName);
  return <Icon className="terminal-icon" style={box} aria-hidden="true" />;
}
