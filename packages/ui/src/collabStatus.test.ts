import { describe, expect, it } from "vitest";

import { DEFAULT_COLLAB_STATUS, describeCollabMode, parseCollabStatus } from "./collabStatus";

describe("DEFAULT_COLLAB_STATUS", () => {
  it("es honesto: desconectado, sin latencia y solo el usuario local", () => {
    expect(DEFAULT_COLLAB_STATUS).toEqual({ connected: false, syncMs: null, collaborators: 1 });
  });
});

describe("parseCollabStatus", () => {
  it("acepta un estado conectado", () => {
    expect(parseCollabStatus({ connected: true, syncMs: 12, collaborators: 2 })).toEqual({
      connected: true,
      syncMs: 12,
      collaborators: 2,
    });
  });

  it("sin conexión no hay latencia, aunque el payload traiga una", () => {
    expect(parseCollabStatus({ connected: false, syncMs: 12, collaborators: 1 }).syncMs).toBeNull();
  });

  it("conectado sin latencia válida la deja en null", () => {
    expect(parseCollabStatus({ connected: true, syncMs: null, collaborators: 1 }).syncMs).toBeNull();
  });

  it("un payload malformado cae a los valores honestos", () => {
    expect(parseCollabStatus(null)).toEqual(DEFAULT_COLLAB_STATUS);
    expect(parseCollabStatus({ connected: "sí", collaborators: -3 })).toEqual(DEFAULT_COLLAB_STATUS);
  });
});

describe("describeCollabMode", () => {
  it("en modo local marca la colaboración como inactiva con textos explícitos", () => {
    const local = describeCollabMode("local");
    expect(local.inactive).toBe(true);
    expect(local.inviteTitle).toContain("Modo local");
    expect(local.workspaceMetaTitle).toBe("Colaboración inactiva en modo local");
    expect(local.onlineLabel).toBe("Local · colaboración inactiva");
    expect(local.anonymousHint).toBe("Colaboración inactiva en modo local");
    expect(local.statusBarTitle).toBe("Colaboración inactiva en modo local");
  });

  it("en modo cloud mantiene la colaboración activa", () => {
    const cloud = describeCollabMode("cloud");
    expect(cloud.inactive).toBe(false);
    expect(cloud.inviteTitle).toBe("Requiere el relay: todavía no está conectado");
    expect(cloud.workspaceMetaTitle).toBeUndefined();
    expect(cloud.onlineLabel).toBe("Online");
    expect(cloud.anonymousHint).toBe("Sign in to collaborate");
    expect(cloud.statusBarTitle).toBeUndefined();
  });
});
