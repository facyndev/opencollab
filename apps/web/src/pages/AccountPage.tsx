import { useEffect, useState } from "react";
import type { AuthClient, Provider, UserView } from "../services/authClient";
import { Shell, messageOf } from "../components";
import { navigate } from "../utils/router";
import { oauthErrorMessage } from "../utils/validation";

const SIGN_OUT_FAILED = "Could not sign out, try again.";

const PROVIDERS: Record<Provider, string> = { github: "GitHub", google: "Google" };
const isProvider = (value: string | null): value is Provider => value !== null && Object.hasOwn(PROVIDERS, value);

export function AccountPage({
  client,
  search,
  assign,
}: {
  client: AuthClient;
  search: string;
  assign: (url: string) => void;
}) {
  const params = new URLSearchParams(search);
  const linked = params.get("linked");
  const initialError = oauthErrorMessage(params.get("error"));
  const [user, setUser] = useState<UserView | null>(null);
  const [failure, setFailure] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    client.me().then(setUser, (error) => setFailure(messageOf(error)));
  }, [client]);

  const link = async (provider: Provider) => {
    setBusy(true);
    setFailure(null);
    try {
      assign(await client.linkStart(provider));
    } catch (error) {
      setFailure(messageOf(error));
      setBusy(false);
    }
  };

  const signOut = async () => {
    setFailure(null);
    try {
      await client.logout();
    } catch {
      setFailure(SIGN_OUT_FAILED);
      return;
    }
    navigate("/login", true);
  };

  return (
    <Shell title="Your account">
      {isProvider(linked) && (
        <p className="banner ok" role="status">
          {PROVIDERS[linked]} account linked.
        </p>
      )}
      {failure && (
        <p className="banner error" role="alert">
          {failure}
        </p>
      )}
      {user && (
        <dl className="details">
          <dt>Username</dt>
          <dd>{user.username}</dd>
          <dt>Email</dt>
          <dd>{user.email ?? "Not set"}</dd>
          <dt>Display name</dt>
          <dd>{user.displayName ?? "Not set"}</dd>
        </dl>
      )}
      <h2>Link a provider</h2>
      <div className="oauth">
        {(Object.keys(PROVIDERS) as Provider[]).map((provider) => (
          <button key={provider} className="button secondary" type="button" disabled={busy} onClick={() => void link(provider)}>
            Link {PROVIDERS[provider]}
          </button>
        ))}
      </div>
      <button className="button ghost" type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </Shell>
  );
}
