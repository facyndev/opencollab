import { describe, expect, it } from "vitest";

import { cdCommand, joinPath, parentDirectories, parseOsc7 } from "./cwd";

describe("parseOsc7", () => {
  it("convierte una ruta de Windows", () => {
    expect(parseOsc7("file://localhost/C:/Users/facun")).toBe("C:\\Users\\facun");
  });

  it("la raíz de una unidad termina en barra", () => {
    expect(parseOsc7("file://localhost/C:")).toBe("C:\\");
  });

  it("deja las rutas Unix como están", () => {
    expect(parseOsc7("file://host/home/facun")).toBe("/home/facun");
  });

  it("decodifica caracteres escapados", () => {
    expect(parseOsc7("file://localhost/C:/Mis%20Documentos")).toBe("C:\\Mis Documentos");
  });

  it("tolera un % literal sin codificar", () => {
    expect(parseOsc7("file://localhost/C:/100%")).toBe("C:\\100%");
  });

  it("rechaza lo que no es una URI file://", () => {
    expect(parseOsc7("http://x/y")).toBeNull();
  });
});

describe("parentDirectories", () => {
  it("lista los padres de una ruta de Windows hasta la unidad", () => {
    expect(parentDirectories("C:\\Users\\facun\\proyecto")).toEqual([
      "C:\\Users\\facun",
      "C:\\Users",
      "C:\\",
    ]);
  });

  it("lista los padres de una ruta Unix hasta /", () => {
    expect(parentDirectories("/home/facun")).toEqual(["/home", "/"]);
  });

  it("la raíz no tiene padres", () => {
    expect(parentDirectories("C:\\")).toEqual([]);
    expect(parentDirectories("/")).toEqual([]);
  });
});

describe("joinPath", () => {
  it("une con el separador de la plataforma de la ruta", () => {
    expect(joinPath("C:\\Users", "facun")).toBe("C:\\Users\\facun");
    expect(joinPath("C:\\", "Users")).toBe("C:\\Users");
    expect(joinPath("/home", "facun")).toBe("/home/facun");
    expect(joinPath("/", "home")).toBe("/home");
  });
});

describe("cdCommand", () => {
  it("PowerShell: Set-Location literal con comillas simples escapadas", () => {
    expect(cdCommand("PowerShell", "C:\\It's here")).toBe(
      "Set-Location -LiteralPath 'C:\\It''s here'\r",
    );
  });

  it("cmd: cd /d para cambiar también de unidad", () => {
    expect(cdCommand("cmd", "D:\\x")).toBe('cd /d "D:\\x"\r');
  });

  it("shells POSIX: comillas simples escapadas", () => {
    expect(cdCommand("bash", "/tmp/it's")).toBe("cd '/tmp/it'\\''s'\r");
  });
});
