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
