import { useState, type FormEvent } from "react";
import { Field, Link, OAuthButtons, Shell, messageOf } from "../components";
import { validateRegister } from "../utils/validation";
import type { FormProps } from "./LoginPage";

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
