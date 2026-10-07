import { useEffect, useState, type FormEvent } from "react";
import type { AuthClient, Provider, UserView } from "./authClient";
import { Field, Link, OAuthButtons, Shell, messageOf } from "./components";
import { navigate } from "./router";
import { oauthErrorMessage, validateLogin, validateRegister } from "./validation";

interface FormProps {
  client: AuthClient;
  search: string;
  onAuthenticated: () => void;
}

export function LoginPage({ client, search, onAuthenticated }: FormProps) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<ReturnType<typeof validateLogin>>({});
  const [failure, setFailure] = useState<string | null>(() => oauthErrorMessage(new URLSearchParams(search).get("error")));
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validateLogin({ identifier, password });
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      await client.login(identifier.trim(), password);
      onAuthenticated();
    } catch (error) {
      setFailure(messageOf(error));
      setBusy(false);
    }
  };

  return (
    <Shell title="Sign in to OpenCollab">
      {failure && (
        <p className="banner error" role="alert">
          {failure}
        </p>
      )}
      <form onSubmit={submit} noValidate>
        <Field
          id="identifier"
          label="Username or email"
          autoComplete="username"
          value={identifier}
          error={errors.identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          error={errors.password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="divider">or</p>
      <OAuthButtons />
      <p className="alt">
        New here? <Link to="/register">Create an account</Link>
      </p>
    </Shell>
  );
}

export function RegisterPage({ client, onAuthenticated }: Omit<FormProps, "search">) {
  const [values, setValues] = useState({ username: "", password: "", email: "", displayName: "" });
  const [errors, setErrors] = useState<ReturnType<typeof validateRegister>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bind = (key: keyof typeof values) => ({
    value: values[key],
    error: errors[key],
    onChange: (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value })),
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validateRegister(values);
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      await client.register({ ...values, username: values.username.trim() });
      onAuthenticated();
    } catch (error) {
      setFailure(messageOf(error));
      setBusy(false);
    }
  };

  return (
    <Shell title="Create your account">
      {failure && (
        <p className="banner error" role="alert">
          {failure}
        </p>
      )}
      <form onSubmit={submit} noValidate>
        <Field id="username" label="Username" autoComplete="username" hint="3-32 letters, digits, _ or -." {...bind("username")} />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="Use 10 or more characters."
          {...bind("password")}
        />
        <Field id="email" label="Email (optional)" type="email" autoComplete="email" {...bind("email")} />
        <Field id="displayName" label="Display name (optional)" autoComplete="name" {...bind("displayName")} />
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </button>
      </form>
      <p className="divider">or</p>
      <OAuthButtons />
      <p className="alt">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </Shell>
  );
}

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

export function ContinuePage({
  client,
  onContinue,
  onSwitch,
}: {
  client: AuthClient;
  onContinue: () => void;
  onSwitch: () => void;
}) {
  const [user, setUser] = useState<UserView | null>(null);
  useEffect(() => {
    client.me().then(setUser, () => undefined);
  }, [client]);
  return (
    <Shell title="Continue to OpenCollab desktop">
      <p>You are already signed in on the web. Link this session to the desktop app?</p>
      <button className="button primary" type="button" disabled={!user} onClick={onContinue}>
        {user ? `Continue as ${user.username}` : "Loading…"}
      </button>
      <button className="button secondary" type="button" onClick={onSwitch}>
        Use a different account
      </button>
    </Shell>
  );
}

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
    await client.logout();
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
