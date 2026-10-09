import { describe, expect, it } from "vitest";

import { elapsedSince, formatElapsed } from "./duration";

describe("formatElapsed", () => {
  it("shows seconds under a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(45)).toBe("45s");
    expect(formatElapsed(59)).toBe("59s");
  });

  it("shows whole minutes under an hour", () => {
    expect(formatElapsed(60)).toBe("1m");
    expect(formatElapsed(12 * 60 + 59)).toBe("12m");
    expect(formatElapsed(59 * 60 + 59)).toBe("59m");
  });

  it("shows hours with zero-padded minutes", () => {
    expect(formatElapsed(3600)).toBe("1h 00m");
    expect(formatElapsed(3600 + 5 * 60)).toBe("1h 05m");
    expect(formatElapsed(26 * 3600 + 30 * 60)).toBe("26h 30m");
  });

  it("never shows negative or fractional time", () => {
    expect(formatElapsed(-5)).toBe("0s");
    expect(formatElapsed(45.9)).toBe("45s");
  });
});

describe("elapsedSince", () => {
  it("is the whole seconds between an epoch-seconds start and now in ms", () => {
    expect(elapsedSince(1_000, 1_045_500)).toBe(45);
  });

  it("clamps a start in the future (clock skew) to zero", () => {
    expect(elapsedSince(2_000, 1_000_000)).toBe(0);
  });
});
