import type { InputHTMLAttributes, MouseEvent, ReactNode } from "react";
import { navigate } from "./router";

export function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="shell">
      <div className="card">
        <p className="brand">OpenCollab</p>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** In-app link: client-side navigation on a plain click, a normal link otherwise. */
export function Link({ to, children }: { to: string; children: ReactNode }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick}>
      {children}
    </a>
  );
}

export function Field({
  label,
  error,
  hint,
  id,
  ...input
}: { label: string; error?: string; hint?: string; id: string } & InputHTMLAttributes<HTMLInputElement>) {
  const describedBy = [error ? `${id}-error` : "", hint ? `${id}-hint` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
      {hint && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

export function OAuthButtons() {
  return (
    <div className="oauth">
      <a className="button secondary" href="/auth/oauth/github/start?client=web">
        Continue with GitHub
      </a>
      <a className="button secondary" href="/auth/oauth/google/start?client=web">
        Continue with Google
      </a>
    </div>
  );
}

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong. Please try again.";
