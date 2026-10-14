import { useEffect, useState } from "react";
import type { AuthClient, UserView } from "../services/authClient";
import { Shell, messageOf } from "../components";

export function WorkingPage({ text }: { text: string }) {
  return (
    <Shell title="One moment">
      <p aria-live="polite">{text}</p>
    </Shell>
  );
}

export function DonePage() {
  return (
    <Shell title="You can return to OpenCollab">
      <p>You are signed in. Switch back to the OpenCollab desktop app to continue. You can close this tab.</p>
    </Shell>
  );
}

export function HandoffErrorPage({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Shell title="Could not reach the desktop app">
      <p className="banner error" role="alert">
        {message}
      </p>
      <button className="button primary" type="button" onClick={onRetry}>
        Try again
      </button>
    </Shell>
  );
}

const SIGN_OUT_FAILED = "Could not sign out, try again.";

export function ContinuePage({
  client,
  onContinue,
  onSwitch,
}: {
  client: AuthClient;
  onContinue: () => void;
  /** Signs out of the web session; rejects when the server could not confirm it. */
  onSwitch: () => Promise<unknown>;
}) {
  const [user, setUser] = useState<UserView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    client.me().then(
      (value) => current && setUser(value),
      (error) => current && setFailure(messageOf(error)),
    );
    return () => {
      current = false;
    };
  }, [client, attempt]);

  const retry = () => {
    setFailure(null);
    setAttempt((n) => n + 1);
  };
  const switchAccount = () => {
    setFailure(null);
    onSwitch().catch(() => setFailure(SIGN_OUT_FAILED));
  };

  return (
    <Shell title="Continue to OpenCollab desktop">
      <p>You are already signed in on the web. Link this session to the desktop app?</p>
      {failure && (
        <p className="banner error" role="alert">
          {failure}
        </p>
      )}
      <button className="button primary" type="button" disabled={!user} onClick={onContinue}>
        {user ? `Continue as ${user.username}` : failure ? "Unavailable" : "Loading…"}
      </button>
      {failure && !user && (
        <button className="button secondary" type="button" onClick={retry}>
          Try again
        </button>
      )}
      <button className="button secondary" type="button" onClick={switchAccount}>
        Use a different account
      </button>
    </Shell>
  );
}
