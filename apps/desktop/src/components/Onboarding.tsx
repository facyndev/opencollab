import { opencollabLogoTransparent, type AuthState } from "@opencollab/ui";
import type { StorageMode } from "../services/storage";
import { StorageAuth } from "./StorageAuth";

type Props = {
  auth: AuthState;
  authBusy: boolean;
  authError: string | null;
  loginUrl: string | null;
  busy: boolean;
  error: string | null;
  onChoose: (mode: StorageMode) => void;
  onSignIn: () => void;
  onCancelLogin: () => void;
};

/// Primera corrida: el usuario elige dónde vive la estructura del escritorio.
/// Cloud exige sesión; ambas opciones persisten la elección antes de entrar.
export function Onboarding(props: Props) {
  const signedIn = props.auth.status === "authenticated";
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <img src={opencollabLogoTransparent} alt="OpenCollab" className="onboarding-logo" />
        <h1>Welcome to OpenCollab</h1>
        <p className="onboarding-lead">Choose where your workspace structure lives.</p>

        <div className="onboarding-modes">
          <button
            type="button"
            className="onboarding-mode"
            disabled={props.busy}
            onClick={() => props.onChoose("local")}
          >
            <strong>Local</strong>
            <span>Saved on this computer. Works offline and needs no account.</span>
          </button>
          <button
            type="button"
            className="onboarding-mode"
            disabled={!signedIn || props.busy}
            onClick={() => props.onChoose("cloud")}
          >
            <strong>Cloud</strong>
            <span>Stored in your OpenCollab account. Sign in to enable it.</span>
          </button>
        </div>

        {!signedIn && (
          <StorageAuth
            auth={props.auth}
            busy={props.authBusy}
            error={props.authError}
            loginUrl={props.loginUrl}
            onSignIn={props.onSignIn}
            onCancelLogin={props.onCancelLogin}
          />
        )}

        {props.error && (
          <p className="settings-error" role="alert">
            {props.error}
          </p>
        )}
        <p className="onboarding-footnote">You can change this later in Settings.</p>
      </div>
    </div>
  );
}
