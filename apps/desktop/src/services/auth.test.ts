import { describe, expect, it } from "vitest";

import { createPkcePair, initialsOf, isAuthCallback, type AuthUser } from "./auth";

describe("isAuthCallback", () => {
  it("acepta el callback del desktop", () => {
    expect(isAuthCallback("opencollab://auth/callback?code=abc123")).toBe(true);
  });

  it("rechaza deep links ajenos", () => {
    expect(isAuthCallback("opencollab://other/path?code=abc")).toBe(false);
    expect(isAuthCallback("opencollab://auth/callback")).toBe(false);
    expect(isAuthCallback("https://evil.example/auth/callback?code=abc")).toBe(false);
    expect(isAuthCallback("not a url")).toBe(false);
  });
});

describe("createPkcePair", () => {
  it("genera un challenge S256 válido (43 caracteres base64url)", async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // S256 = base64url(SHA-256(verifier)).
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const bytes = new Uint8Array(digest);
    let text = "";
    for (const b of bytes) text += String.fromCharCode(b);
    const expected = btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    expect(challenge).toBe(expected);
  });
});

describe("initialsOf", () => {
  const user = (displayName: string, username = "user"): AuthUser => ({
    id: "1",
    username,
    email: null,
    displayName,
  });

  it("usa nombre y apellido", () => {
    expect(initialsOf(user("Facundo García"))).toBe("FG");
  });

  it("cae al username sin nombre visible", () => {
    expect(initialsOf(user("  ", "opencollab"))).toBe("O");
  });
});
