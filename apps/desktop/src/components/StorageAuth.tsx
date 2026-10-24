import { Button, type AuthState } from "@opencollab/ui";

type Props = {
  auth: AuthState;
  busy: boolean;
  error: string | null;
  loginUrl: string | null;
  onSignIn: () => void;
  onCancelLogin: () => void;
};

/// Bloque de login reutilizado por el onboarding y Settings: el modo nube
/// necesita una sesión, y el login siempre ocurre en el navegador.
export function StorageAuth(props: Props) {
  if (props.auth.status === "authenticated") {
    return (
      <p className="storage-auth storage-auth--ok">
        Signed in as {props.auth.user.displayName || props.auth.user.username}
      </p>
    );
  }
  if (props.auth.status === "unknown") {
    return <p className="storage-auth">Checking session…</p>;
  }
  return (
    <div className="storage-auth">
      <div className="storage-auth-row">
        {props.busy ? (
          <Button onClick={props.onCancelLogin}>Cancel</Button>
        ) : (
          <Button onClick={props.onSignIn}>Sign in</Button>
        )}
        <span>{props.busy ? "Finish sign-in in your browser" : "Sign in to use cloud storage"}</span>
      </div>
      {props.error && (
        <p className="settings-error" role="alert">
          {props.error}
        </p>
      )}
      {props.busy && props.loginUrl && (
        <a className="user-link" href={props.loginUrl} target="_blank" rel="noreferrer">
          Open login page
        </a>
      )}
    </div>
  );
}
