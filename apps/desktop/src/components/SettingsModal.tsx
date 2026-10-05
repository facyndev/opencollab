import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { agentInfo, type AgentId } from "../agents";
import { Close } from "../icons";
import {
  getHookStatus,
  installAgentHooks,
  uninstallAgentHooks,
  type HookState,
} from "../subagentsApi";
import { Button, IconButton } from "./Button";
import { TerminalIcon } from "./TerminalIcon";

type AgentConfig = {
  id: AgentId;
  configFile: string;
};

const AGENT_CONFIGS: AgentConfig[] = [
  { id: "claude-code", configFile: "~/.claude/settings.json" },
  { id: "opencode", configFile: "~/.config/opencode/plugins/opencollab.ts" },
  { id: "codex", configFile: "~/.codex/hooks.json" },
  { id: "antigravity-cli", configFile: "No expone eventos de subagente" },
];

type Props = {
  onClose: () => void;
};

type ConfirmState = {
  agent: AgentId;
  action: "install" | "uninstall";
};

type Feedback = {
  type: "success" | "error";
  message: string;
};

export function SettingsModal({ onClose }: Props) {
  const [statuses, setStatuses] = useState<Record<AgentId, HookState>>({
    "claude-code": "notInstalled",
    opencode: "notInstalled",
    codex: "notInstalled",
    "antigravity-cli": "unsupported",
  });
  const [statusErrors, setStatusErrors] = useState<Partial<Record<AgentId, string>>>({});
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const refreshStatuses = async () => {
    try {
      const list = await getHookStatus();
      const nextStatuses: Partial<Record<AgentId, HookState>> = {};
      const nextErrors: Partial<Record<AgentId, string>> = {};
      for (const item of list) {
        nextStatuses[item.agent] = item.status;
        if (item.error) nextErrors[item.agent] = item.error;
      }
      setStatuses((prev) => ({ ...prev, ...nextStatuses }));
      setStatusErrors(nextErrors);
    } catch (err) {
      setFeedback({
        type: "error",
        message: `Error al consultar estado de hooks: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  useEffect(() => {
    refreshStatuses();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (confirm) {
          setConfirm(null);
          setConfirmError(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [confirm, onClose]);

  const handleConfirmAction = async () => {
    if (!confirm) return;
    setBusy(true);
    setConfirmError(null);
    const { agent, action } = confirm;
    const isInstall = action === "install";

    try {
      if (isInstall) {
        await installAgentHooks(agent);
      } else {
        await uninstallAgentHooks(agent);
      }
      await refreshStatuses();
      setConfirm(null);
      setFeedback({
        type: "success",
        message: isInstall
          ? `Hooks de ${agentInfo(agent).name} instalados con éxito.`
          : `Hooks de ${agentInfo(agent).name} desinstalados con éxito.`,
      });
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      if (confirm) {
        setConfirm(null);
        setConfirmError(null);
      } else {
        onClose();
      }
    }
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onBackdropClick}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="modal-header">
          <h2 id="settings-title" className="modal-title">
            Subagentes y hooks
          </h2>
          <IconButton
            icon={<Close />}
            title="Cerrar"
            className="modal-close"
            onClick={onClose}
          />
        </div>

        <div className="modal-body">
          <p className="settings-description">
            Los subagentes de Claude Code, OpenCode y Codex requieren hooks locales
            para integrarse con OpenCollab y emitir eventos de inicio y fin en tiempo real.
          </p>

          {feedback && (
            <div className={`settings-feedback settings-feedback--${feedback.type}`}>
              {feedback.message}
            </div>
          )}

          <ul className="agent-list">
            {AGENT_CONFIGS.map((agent) => {
              const info = agentInfo(agent.id);
              const state = statuses[agent.id] ?? (agent.id === "antigravity-cli" ? "unsupported" : "notInstalled");
              const err = statusErrors[agent.id];

              return (
                <li key={agent.id} className="agent-row" data-agent={agent.id}>
                  <div className="agent-row-info">
                    <TerminalIcon agent={agent.id} shellName="" size={20} />
                    <div className="agent-row-text">
                      <span className="agent-row-name">{info.name}</span>
                      <span className="agent-row-path" title={agent.configFile}>
                        {agent.configFile}
                      </span>
                    </div>
                  </div>

                  <div className="agent-row-actions">
                    {state === "installed" && (
                      <>
                        <span className="badge badge--installed">Instalado</span>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setFeedback(null);
                            setConfirm({ agent: agent.id, action: "uninstall" });
                          }}
                        >
                          Desinstalar
                        </Button>
                      </>
                    )}

                    {state === "notInstalled" && (
                      <>
                        <span className="badge badge--notInstalled">No instalado</span>
                        <Button
                          variant="primary"
                          onClick={() => {
                            setFeedback(null);
                            setConfirm({ agent: agent.id, action: "install" });
                          }}
                        >
                          Instalar
                        </Button>
                      </>
                    )}

                    {state === "unsupported" && (
                      <span className="badge badge--unsupported">No soportado</span>
                    )}

                    {state === "error" && (
                      <span className="badge badge--error" title={err}>
                        Error
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {confirm && (
          <div className="modal-confirm-overlay">
            <div
              className="modal-confirm"
              role="dialog"
              aria-modal="true"
              aria-labelledby="confirm-dialog-title"
            >
              <h3 id="confirm-dialog-title" className="modal-confirm-title">
                {confirm.action === "install"
                  ? `¿Instalar hooks para ${agentInfo(confirm.agent).name}?`
                  : `¿Desinstalar hooks de ${agentInfo(confirm.agent).name}?`}
              </h3>

              <p className="modal-confirm-desc">
                {confirm.action === "install" ? (
                  <>
                    Se modificará el archivo{" "}
                    <code>{AGENT_CONFIGS.find((a) => a.id === confirm.agent)?.configFile}</code> para
                    integrar los subagentes con OpenCollab.
                  </>
                ) : (
                  <>
                    Se removerá la integración de OpenCollab en{" "}
                    <code>{AGENT_CONFIGS.find((a) => a.id === confirm.agent)?.configFile}</code>.
                  </>
                )}
              </p>

              {confirmError && <p className="modal-error">{confirmError}</p>}

              <div className="modal-confirm-actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setConfirm(null);
                    setConfirmError(null);
                  }}
                >
                  Cancelar
                </Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={handleConfirmAction}
                >
                  {busy ? "Procesando..." : "Confirmar"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
