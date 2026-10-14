import { useState, type FormEvent } from "react";
import type { AuthClient } from "../services/authClient";
import { Field, Link, OAuthButtons, Shell, messageOf } from "../components";
import { oauthErrorMessage, validateLogin } from "../utils/validation";

export interface FormProps {
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
