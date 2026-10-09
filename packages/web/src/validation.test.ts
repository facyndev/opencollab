import { describe, expect, it } from "vitest";
import { oauthErrorMessage, validateLogin, validateRegister } from "./validation";

const ok = { username: "ada_l-1", password: "0123456789", email: "", displayName: "" };

describe("validateRegister", () => {
  it("accepts a minimal valid form", () => {
    expect(validateRegister(ok)).toEqual({});
  });

  it.each(["ab", "a".repeat(33), "has space", "ünï", "dot.name", ""])("rejects username %j", (username) => {
    expect(validateRegister({ ...ok, username }).username).toMatch(/3.32/);
  });

  it("accepts the username length bounds", () => {
    expect(validateRegister({ ...ok, username: "abc" })).toEqual({});
    expect(validateRegister({ ...ok, username: "a".repeat(32) })).toEqual({});
  });

  it("enforces password 10-256", () => {
    expect(validateRegister({ ...ok, password: "123456789" }).password).toMatch(/10/);
    expect(validateRegister({ ...ok, password: "x".repeat(257) }).password).toMatch(/256/);
    expect(validateRegister({ ...ok, password: "x".repeat(256) })).toEqual({});
  });

  it("validates the email only when provided", () => {
    expect(validateRegister({ ...ok, email: "nope" }).email).toBeDefined();
    expect(validateRegister({ ...ok, email: "a@b.co" })).toEqual({});
    expect(validateRegister({ ...ok, email: "a@".padEnd(260, "b") + ".co" }).email).toBeDefined();
  });

  it("limits the display name to 64 characters", () => {
    expect(validateRegister({ ...ok, displayName: "x".repeat(65) }).displayName).toBeDefined();
    expect(validateRegister({ ...ok, displayName: "x".repeat(64) })).toEqual({});
  });
});

describe("validateLogin", () => {
  it("requires both fields", () => {
    expect(validateLogin({ identifier: "", password: "" })).toEqual({
      identifier: expect.any(String),
      password: expect.any(String),
    });
    expect(validateLogin({ identifier: "ada", password: "x" })).toEqual({});
  });
});

describe("oauthErrorMessage", () => {
  it.each(["access_denied", "invalid_state", "conflict", "provider_unavailable", "failed"])("knows %s", (code) => {
    expect(oauthErrorMessage(code)).toMatch(/\w/);
  });

  it("falls back to a generic message for unknown codes and never echoes them", () => {
    const message = oauthErrorMessage("<script>alert(1)</script>");
    expect(message).not.toContain("script");
    expect(message).toBe(oauthErrorMessage("failed"));
  });

  it("returns null when there is no error", () => {
    expect(oauthErrorMessage(null)).toBeNull();
  });
});
