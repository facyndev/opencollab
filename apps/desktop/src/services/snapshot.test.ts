import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";
import { newPane, newSession, newWorkspace } from "@opencollab/ui";

import {
  flushSnapshotSaves,
  fromSavedSnapshot,
  saveSnapshot,
  toSavedWorkspaces,
  type SavedSnapshot,
} from "./snapshot";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mockedInvoke = vi.mocked(invoke);

// Espejo del payload camelCase que serializa el núcleo Rust
// (`WorkspaceSnapshot::new` → serde). Candados del formato: solo perfil de
// arranque de las terminales, nunca `env` ni scrollback (A1 del feature).
const saved: SavedSnapshot = {
  workspaces: [
    {
      id: "ws-1",
      name: "trabajo",
      sessions: [
        {
          id: "session-1",
          name: "con pane",
          panes: [
            {
              id: "pane-1",
              seq: 500,
              minimized: true,
              initialCwd: "C:\\repo",
              agent: "claude-code",
            },
          ],
        },
        { id: "session-2", name: "sin panes", panes: [] },
      ],
    },
  ],
};

function uiWorkspaceWithSavedPanes() {
  const ws = newWorkspace("local");
  ws.members = 3;
  ws.sessions.push(newSession("extra"));
  ws.sessions[0].panes.push(newPane("C:\\repo", "opencode"));
  return ws;
}

describe("toSavedWorkspaces", () => {
  it("deja solo los campos persistentes, con las claves camelCase del núcleo", () => {
    const ws = uiWorkspaceWithSavedPanes();
    const [savedWs] = toSavedWorkspaces([ws]);

    // `members` y todo estado volátil de la UI no viajan al snapshot.
    expect(savedWs).toEqual({
      id: ws.id,
      name: "local",
      sessions: [
        {
          id: ws.sessions[0].id,
          name: "Sesión 1",
          panes: [
            {
              id: ws.sessions[0].panes[0].id,
              seq: ws.sessions[0].panes[0].seq,
              minimized: false,
              initialCwd: "C:\\repo",
              agent: "opencode",
            },
          ],
        },
        { id: ws.sessions[1].id, name: "extra", panes: [] },
      ],
    });
  });
});

describe("fromSavedSnapshot", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("reconstruye workspaces de la UI; `members` vuelve al default local", () => {
    const [ws] = fromSavedSnapshot(saved)!;
    expect(ws).toEqual({
      id: "ws-1",
      name: "trabajo",
      members: 1,
      sessions: [
        {
          id: "session-1",
          name: "con pane",
          panes: [
            {
              id: "pane-1",
              seq: 500,
              minimized: true,
              initialCwd: "C:\\repo",
              agent: "claude-code",
            },
          ],
        },
        { id: "session-2", name: "sin panes", panes: [] },
      ],
    });
  });

  it("rebasa el contador de seq: nuevos paneles no colisionan con los restaurados", () => {
    fromSavedSnapshot(saved);
    expect(newPane().seq).toBeGreaterThan(500);
  });

  it("un agente que ya no está en el catálogo cae a `null` (shell plana)", () => {
    const peninsula = {
      ...saved,
      workspaces: [
        {
          ...saved.workspaces[0],
          sessions: [
            {
              ...saved.workspaces[0].sessions[0],
              panes: [{ ...saved.workspaces[0].sessions[0].panes[0], agent: "agente-fantasma" }],
            },
          ],
        },
      ],
    } satisfies SavedSnapshot;
    const [ws] = fromSavedSnapshot(peninsula)!;
    expect(ws.sessions[0].panes[0].agent).toBeNull();
  });

  it("caída a `null` ante un payload inválido", () => {
    expect(fromSavedSnapshot(null)).toBeNull();
    expect(fromSavedSnapshot({} as SavedSnapshot)).toBeNull();
    expect(fromSavedSnapshot({ workspaces: [] })).toBeNull();
    expect(fromSavedSnapshot({ workspaces: [null as never] })).toBeNull();
    expect(
      fromSavedSnapshot({
        workspaces: [{ id: "ws-1", name: "x", sessions: [{ id: "s-1", name: "y", panes: [{}] as never }] }],
      }),
    ).toBeNull();
  });
});

describe("loadSnapshot/saveSnapshot", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("sin datos guardados devuelve `null` (primera corrida / arranque limpio)", async () => {
    mockedInvoke.mockResolvedValueOnce(null);
    expect(await (await import("./snapshot")).loadSnapshot()).toBeNull();
  });

  it("el guardado siguiente espera al anterior: nunca se cruzan los writes", async () => {
    let release: (() => void) | undefined;
    let firstDone = false;
    try {
      const marks: ("after" | "before")[] = [];
      mockedInvoke
        // Primera escritura que depende de un `release` manual y segunda rápida:
        // si el guardado no se encadenara, a la segunda no le importaría la primera.
        .mockImplementationOnce(
          () =>
            new Promise((res) => {
              release = () => {
                firstDone = true;
                res(null);
              };
            }),
        )
        .mockImplementationOnce(() => {
          marks.push(firstDone ? "after" : "before");
          return Promise.resolve(null);
        });
      const first = saveSnapshot([uiWorkspaceWithSavedPanes()]);
      const second = saveSnapshot([]);
      // Un turno corto de timers: bastante para que la cola despache al primero
      // y encadene al segundo detrás de su resolución.
      await new Promise((r) => setTimeout(r, 10));
      expect(mockedInvoke).toHaveBeenCalledTimes(1);
      release!();
      await Promise.all([first, second]);
      expect(firstDone).toBe(true);
      expect(marks).toEqual(["after"]);
      expect(mockedInvoke).toHaveBeenCalledTimes(2);
      expect(mockedInvoke.mock.calls[0][0]).toBe("snapshot_save");
      expect(mockedInvoke.mock.calls[0][1]).toEqual({
        workspaces: expect.any(Array),
      });
    } finally {
      release?.();
      await Promise.resolve();
    }
  });

  it("un guardado que falla no bloquea los siguientes", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("disk full"));
    const first = saveSnapshot([uiWorkspaceWithSavedPanes()]);
    const second = saveSnapshot([uiWorkspaceWithSavedPanes()]);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
  });

  it("flush espera el guardado en vuelo antes de cambiar de store", async () => {
    let release: (() => void) | undefined;
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = () => res(null);
        }),
    );
    const pending = saveSnapshot([uiWorkspaceWithSavedPanes()]);
    let flushed = false;
    const flush = flushSnapshotSaves().then(() => {
      flushed = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(flushed).toBe(false);
    release!();
    await Promise.all([pending, flush]);
    expect(flushed).toBe(true);
  });
});
