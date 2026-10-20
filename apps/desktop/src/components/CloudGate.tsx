import { Button, opencollabLogoTransparent, type AuthState } from "@opencollab/ui";

import { StorageAuth } from "./StorageAuth";

type Props = {
  auth: AuthState;
  authBusy: boolean;
  authError: string | null;
  loginUrl: string | null;
  busy: boolean;
  error: string | null;
  onSignIn: () => void;
  onCancelLogin: () => void;
  onSignOut: () => void;
  onRetry: () => void;
  onUseLocal: () => void;
};

/// Gate del modo cloud: sin sesión no se monta la grilla, y si el snapshot
/// cloud no carga se ofrece reintentar o volver a local. Evita arrancar en
/// cloud con la persistencia apagada y perder mutaciones en silencio.
export function CloudGate(props: Props) {
  const signedIn = props.auth.status === "authenticated";
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <img src={opencollabLogoTransparent} alt="OpenCollab" className="onboarding-logo" />
        <h1>OpenCollab Cloud</h1>
        <p className="onboarding-lead">
          {signedIn
            ? "We couldn't load your cloud workspace."
            : "Sign in to load your workspace structure from the cloud."}
        </p>

        <StorageAuth
          auth={props.auth}
          busy={props.authBusy}
          error={props.authError}
          loginUrl={props.loginUrl}
          onSignIn={props.onSignIn}
          onCancelLogin={props.onCancelLogin}
        />

        {props.error && (
          <p className="settings-error" role="alert">
            {props.error}
          </p>
        )}

        <div className="onboarding-actions">
          {props.error && (
            <Button onClick={props.onRetry} disabled={props.busy}>
              Retry
            </Button>
          )}
          {signedIn && (
            <Button onClick={props.onSignOut} disabled={props.busy}>
              Sign out
            </Button>
          )}
          <Button variant="primary" onClick={props.onUseLocal} disabled={props.busy}>
            Use local storage instead
          </Button>
        </div>

        <p className="onboarding-footnote">
          Cloud storage needs an account. Local storage stays on this computer.
        </p>
      </div>
    </div>
  );
}
