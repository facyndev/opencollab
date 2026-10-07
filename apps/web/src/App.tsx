import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AuthClient } from "./authClient";
import { messageOf } from "./components";
import { captureHandoff, readPendingHandoff, runPendingHandoff } from "./handoff";
import {
  AccountPage,
  ContinuePage,
  DonePage,
  HandoffErrorPage,
  LoginPage,
  RegisterPage,
  WorkingPage,
} from "./pages";
import { navigate, useLocation } from "./router";

type Handoff = { kind: "idle" } | { kind: "running" } | { kind: "done" } | { kind: "error"; message: string };

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, true), [to]);
  return null;
}

export function App({
  client,
  assign = (url) => window.location.assign(url),
}: {
  client: AuthClient;
  assign?: (url: string) => void;
}) {
  const { pathname, search } = useLocation();
  const auth = useSyncExternalStore(client.subscribe, client.getState);
  const [booted, setBooted] = useState(false);
  // Whether the visitor arrived already signed in with a desktop request pending.
  const [offerContinue, setOfferContinue] = useState(false);
  const [handoff, setHandoff] = useState<Handoff>({ kind: "idle" });
  const completing = useRef(false);

  // A desktop request arrives on /login; remember its challenge before anything else.
  useState(() => {
    if (pathname === "/login") captureHandoff(search);
  });

  useEffect(() => {
    client
      .refresh()
      .catch(() => undefined)
      .finally(() => {
        setOfferContinue(client.getState().status === "authenticated" && readPendingHandoff() !== null);
        setBooted(true);
      });
  }, [client]);

  const finish = useCallback(async () => {
    setHandoff({ kind: "running" });
    try {
      if (await runPendingHandoff(client, assign)) setHandoff({ kind: "done" });
      else {
        setHandoff({ kind: "idle" });
        navigate("/account", true);
      }
    } catch (error) {
      setHandoff({ kind: "error", message: messageOf(error) });
    }
  }, [client, assign]);

  useEffect(() => {
    if (!booted || pathname !== "/auth/complete" || completing.current) return;
    completing.current = true;
    if (client.getState().status === "authenticated") void finish();
    else navigate("/login?error=failed", true);
  }, [booted, pathname, client, finish]);

  if (!booted) return <WorkingPage text="Loading…" />;
  if (handoff.kind === "done") return <DonePage />;
  if (handoff.kind === "running") return <WorkingPage text="Connecting to the desktop app…" />;
  if (handoff.kind === "error") return <HandoffErrorPage message={handoff.message} onRetry={() => void finish()} />;

  const authed = auth.status === "authenticated";

  switch (pathname) {
    case "/login":
    case "/register": {
      if (authed && offerContinue) {
        return (
          <ContinuePage
            client={client}
            onContinue={() => void finish()}
            onSwitch={() => {
              void client.logout().then(() => setOfferContinue(false));
            }}
          />
        );
      }
      if (authed) return <Redirect to="/account" />;
      return pathname === "/login" ? (
        <LoginPage client={client} search={search} onAuthenticated={() => void finish()} />
      ) : (
        <RegisterPage client={client} onAuthenticated={() => void finish()} />
      );
    }
    case "/auth/complete":
      return <WorkingPage text="Finishing sign-in…" />;
    case "/account":
      return authed ? <AccountPage client={client} search={search} assign={assign} /> : <Redirect to="/login" />;
    default:
      return <Redirect to={authed ? "/account" : "/login"} />;
  }
}
