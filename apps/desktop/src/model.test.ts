import { describe, expect, it } from "vitest";

import { newPane, sessionSummary, swapPanes, type PaneStatus } from "./model";

describe("swapPanes", () => {
  it("intercambia dos paneles sin tocar el resto", () => {
    const [a, b, c] = [newPane(), newPane(), newPane()];
    expect(swapPanes([a, b, c], a.id, c.id).map((p) => p.id)).toEqual([c.id, b.id, a.id]);
  });

  it("ignora ids desconocidos", () => {
    const panes = [newPane(), newPane()];
    expect(swapPanes(panes, panes[0].id, "nope")).toBe(panes);
  });

  it("cada panel nuevo tiene un seq mayor (orden estable del DOM)", () => {
    const [a, b] = [newPane(), newPane()];
    expect(b.seq).toBeGreaterThan(a.seq);
  });
});

describe("sessionSummary", () => {
  const panes = [newPane(), newPane()];
  const statuses = (s: PaneStatus[]) => Object.fromEntries(panes.map((p, i) => [p.id, s[i]]));

  it("sin terminales", () => {
    expect(sessionSummary([], {})).toEqual({ tone: "idle", text: "No terminals" });
  });

  it("cuenta las que están vivas", () => {
    expect(sessionSummary(panes, statuses(["running", "done"]))).toEqual({
      tone: "live",
      text: "2 terminals · 1 live",
    });
  });

  it("una fallida marca la sesión como fallida", () => {
    expect(sessionSummary(panes, statuses(["running", "failed"])).tone).toBe("failed");
  });

  it("todas terminadas", () => {
    expect(sessionSummary(panes, statuses(["done", "done"])).tone).toBe("done");
  });
});
