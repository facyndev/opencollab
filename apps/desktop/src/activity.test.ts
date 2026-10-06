import { describe, expect, it } from "vitest";

import { applyActivity, applyFocus, initialActivity, isWatching } from "./activity";

describe("activity", () => {
  it("starts unknown and without attention", () => {
    expect(initialActivity).toEqual({ activity: null, attention: false });
  });

  it("tracks working and idle", () => {
    const working = applyActivity(initialActivity, "working", true);
    expect(working).toEqual({ activity: "working", attention: false });
    expect(applyActivity(working, "idle", true)).toEqual({ activity: "idle", attention: false });
  });

  it("asks for attention when work ends in an unfocused pane", () => {
    const working = applyActivity(initialActivity, "working", false);
    expect(applyActivity(working, "idle", false)).toEqual({ activity: "idle", attention: true });
  });

  it("does not ask for attention if it was never working", () => {
    expect(applyActivity(initialActivity, "idle", false).attention).toBe(false);
  });

  it("keeps the attention flag until the pane is focused", () => {
    const needs = { activity: "idle" as const, attention: true };
    expect(applyActivity(needs, "idle", false).attention).toBe(true);
    expect(applyFocus(needs)).toEqual({ activity: "idle", attention: false });
  });

  it("drops the attention flag when work resumes", () => {
    const needs = { activity: "idle" as const, attention: true };
    expect(applyActivity(needs, "working", false)).toEqual({ activity: "working", attention: false });
  });

  it("focus does not change an unchanged state object", () => {
    const state = applyActivity(initialActivity, "working", true);
    expect(applyFocus(state)).toBe(state);
  });

  describe("isWatching", () => {
    const all = { focused: true, hidden: false, minimized: false, windowFocused: true };

    it("is true only when focused, visible, not minimized and the window has focus", () => {
      expect(isWatching(all)).toBe(true);
    });

    it.each([
      ["not the focused pane", { focused: false }],
      ["hidden (other session)", { hidden: true }],
      ["minimized", { minimized: true }],
      ["window without focus", { windowFocused: false }],
    ])("is false when %s", (_name, patch) => {
      expect(isWatching({ ...all, ...patch })).toBe(false);
    });
  });
});
