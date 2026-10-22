import { useEffect, useState } from "react";
import { Button, Close, IconButton, type AuthState } from "@opencollab/ui";

import type { StorageConfig, StorageMode } from "../services/storage";
import { StorageAuth } from "./StorageAuth";

type Props = {
  storage: StorageConfig;
  auth: AuthState;
  authBusy: boolean;
  authError: string | null;
  loginUrl: string | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (mode: StorageMode, apiBaseUrl: string) => void;
  onSignIn: () => void;
  onCancelLogin: () => void;
};

/// Ajustes de almacenamiento: modo y base URL de la API. El guardado lo hace
/// el núcleo (valida URL y exige sesión para cloud); acá solo se edita.
export function SettingsDialog(props: Props) {
  const [mode, setMode] = useState<StorageMode>(props.storage.mode);
  const [apiBaseUrl, setApiBaseUrl] = useState(props.storage.apiBaseUrl);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const signedIn = props.auth.status === "authenticated";
  const invalidUrl = mode === "cloud" && !/^https?:\/\/\S+$/.test(apiBaseUrl.trim());
  const cloudNeedsLogin = mode === "cloud" && !signedIn;
  const saveDisabled = props.busy || invalidUrl || cloudNeedsLogin;

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={() => props.onClose()}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2 id="settings-title">Settings</h2>
          <IconButton icon={<Close />} title="Close settings" onClick={props.onClose} />
        </header>

        <section className="modal-section">
          <h3>Storage</h3>
          <label className="settings-mode">
            <input
              type="radio"
              name="storage-mode"
              checked={mode === "local"}
              onChange={() => setMode("local")}
            />
            <span>
              <strong>Local</strong>
              <small>Saved on this computer. Works offline and needs no account.</small>
            </span>
          </label>
          <label className="settings-mode">
            <input
              type="radio"
              name="storage-mode"
              checked={mode === "cloud"}
              onChange={() => setMode("cloud")}
            />
            <span>
              <strong>Cloud</strong>
              <small>Stored in your OpenCollab account and shared across devices.</small>
            </span>
          </label>
        </section>

        <label className="settings-field">
          <span>API base URL</span>
          <input
            type="url"
            value={apiBaseUrl}
            spellCheck={false}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            placeholder="http://127.0.0.1:8787"
          />
          <small>Used in cloud mode. Defaults to the local relay.</small>
        </label>

        {cloudNeedsLogin && (
          <div className="settings-auth">
            <p className="settings-warning">Sign in before switching to cloud storage.</p>
            <StorageAuth
              auth={props.auth}
              busy={props.authBusy}
              error={props.authError}
              loginUrl={props.loginUrl}
              onSignIn={props.onSignIn}
              onCancelLogin={props.onCancelLogin}
            />
          </div>
        )}

        {props.storage.mode === "local" && mode === "cloud" && (
          <p className="settings-hint">
            Your local workspaces, sessions, and terminals will be migrated to your cloud account.
            Local files are kept on this computer.
          </p>
        )}

        {invalidUrl && (
          <p className="settings-error" role="alert">
            Enter an absolute http:// or https:// URL.
          </p>
        )}
        {props.error && (
          <p className="settings-error" role="alert">
            {props.error}
          </p>
        )}

        <footer className="modal-actions">
          <Button onClick={props.onClose} disabled={props.busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={saveDisabled}
            onClick={() => props.onSave(mode, apiBaseUrl.trim())}
          >
            {props.busy ? "Saving…" : "Save"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
