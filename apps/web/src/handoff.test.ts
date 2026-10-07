import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureHandoff,
  clearPendingHandoff,
  isValidCodeChallenge,
  readPendingHandoff,
  runPendingHandoff,
} from "./handoff";

const challenge = "A".repeat(43);

beforeEach(() => sessionStorage.clear());

describe("isValidCodeChallenge", () => {
  it("accepts exactly 43 base64url characters", () => {
    expect(isValidCodeChallenge(challenge)).toBe(true);
    expect(isValidCodeChallenge("a-_9".repeat(10) + "abc")).toBe(true);
  });

  it.each(["", "short", "A".repeat(42), "A".repeat(44), "A".repeat(42) + "=", "A".repeat(42) + "+", "A".repeat(42) + " "])(
    "rejects %j",
    (value) => expect(isValidCodeChallenge(value)).toBe(false),
  );
});

describe("captureHandoff", () => {
  it("stores only the challenge when client=desktop and the challenge is valid", () => {
    expect(captureHandoff(`?client=desktop&code_challenge=${challenge}`)).toBe(true);
    expect(readPendingHandoff()).toBe(challenge);
    expect(Object.keys(sessionStorage)).toHaveLength(1);
    expect(sessionStorage.getItem(Object.keys(sessionStorage)[0]!)).toBe(challenge);
  });

  it("ignores an invalid challenge and keeps nothing pending", () => {
    expect(captureHandoff("?client=desktop&code_challenge=nope")).toBe(false);
    expect(readPendingHandoff()).toBeNull();
  });

  it("ignores a non-desktop client", () => {
    expect(captureHandoff(`?client=web&code_challenge=${challenge}`)).toBe(false);
    expect(captureHandoff(`?code_challenge=${challenge}`)).toBe(false);
    expect(readPendingHandoff()).toBeNull();
  });

  it("returns false and leaves a pending handoff alone when the URL carries none", () => {
    captureHandoff(`?client=desktop&code_challenge=${challenge}`);
    expect(captureHandoff("?error=access_denied")).toBe(false);
    expect(readPendingHandoff()).toBe(challenge);
  });

  it("an invalid new request clears a stale pending challenge", () => {
    captureHandoff(`?client=desktop&code_challenge=${challenge}`);
    captureHandoff("?client=desktop&code_challenge=bad");
    expect(readPendingHandoff()).toBeNull();
  });

  it("does not throw when sessionStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => captureHandoff(`?client=desktop&code_challenge=${challenge}`)).not.toThrow();
  });
});

describe("runPendingHandoff", () => {
  it("returns false and does nothing without a pending handoff", async () => {
    const desktopCode = vi.fn();
    const assign = vi.fn();
    expect(await runPendingHandoff({ desktopCode }, assign)).toBe(false);
    expect(desktopCode).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("requests the code, clears the challenge and redirects to the deep link", async () => {
    captureHandoff(`?client=desktop&code_challenge=${challenge}`);
    const desktopCode = vi.fn(async () => "opencollab://auth/callback?code=xyz");
    const assign = vi.fn();
    expect(await runPendingHandoff({ desktopCode }, assign)).toBe(true);
    expect(desktopCode).toHaveBeenCalledWith(challenge);
    expect(assign).toHaveBeenCalledWith("opencollab://auth/callback?code=xyz");
    expect(readPendingHandoff()).toBeNull();
  });

  it("refuses to navigate to anything but the opencollab deep link", async () => {
    captureHandoff(`?client=desktop&code_challenge=${challenge}`);
    const assign = vi.fn();
    await expect(
      runPendingHandoff({ desktopCode: async () => "https://evil.example/steal" }, assign),
    ).rejects.toThrow(/redirect/i);
    expect(assign).not.toHaveBeenCalled();
  });

  it("keeps the challenge pending when the code request fails so it can be retried", async () => {
    captureHandoff(`?client=desktop&code_challenge=${challenge}`);
    await expect(
      runPendingHandoff({ desktopCode: async () => Promise.reject(new Error("boom")) }, vi.fn()),
    ).rejects.toThrow("boom");
    expect(readPendingHandoff()).toBe(challenge);
  });
});

describe("clearPendingHandoff", () => {
  it("drops the pending challenge", () => {
    captureHandoff(`?client=desktop&code_challenge=${challenge}`);
    clearPendingHandoff();
    expect(readPendingHandoff()).toBeNull();
  });
});
