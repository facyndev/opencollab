import { describe, expect, it } from "vitest";

import { DEFAULT_COLLAB_STATUS, parseCollabStatus } from "./collabStatus";

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
