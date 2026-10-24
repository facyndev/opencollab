import { describe, expect, it } from "vitest";

import { anchorMenuPosition, clampMenuPosition } from "./components/PopoverMenu";

describe("PopoverMenu positioning", () => {
  it("anchorMenuPosition aligns to left edge of anchor by default", () => {
    const rect = { left: 40, right: 140, bottom: 32 };
    expect(anchorMenuPosition(rect, "left", 1024)).toEqual({
      left: 40,
      top: 36,
    });
  });

  it("anchorMenuPosition aligns to right edge of anchor when align is right", () => {
    const rect = { left: 800, right: 924, bottom: 32 };
    expect(anchorMenuPosition(rect, "right", 1024)).toEqual({
      right: 100,
      top: 36,
    });
  });

  it("clampMenuPosition keeps context menu inside viewport bounds", () => {
    expect(clampMenuPosition(100, 120, 1000, 800)).toEqual({
      left: 100,
      top: 120,
    });
    expect(clampMenuPosition(950, 760, 1000, 800, 210, 160)).toEqual({
      left: 782,
      top: 632,
    });
  });
});
