// Línea secundaria del hilo del sidebar: actividad (working / idle / needs
// attention), tiempo corriendo y rama de git, todo agnóstico del agente.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Texto de la línea secundaria de cada terminal del hilo (null = sin línea).
const metaLines = (page) =>
  page.$$eval(".thread > li", (items) =>
    items.map((li) => li.querySelector(":scope > .thread-meta")?.textContent ?? null),
  );

export default async function threadMeta(page, checks) {
  await page.click(".topbar .btn--primary"); // t2, queda enfocada
  await wait(400);

  // t1 (sin foco) corre un agente; t2 es solo una shell.
  await page.evaluate(() => {
    // Arrancó hace 12 minutos (el núcleo informa segundos desde la época Unix).
    const startedAt = Math.floor(Date.now() / 1000) - 12 * 60;
    window.__mock.emit("terminal-agent", { terminalId: "t1", agents: ["claude-code"], startedAt });
    window.__mock.emit("terminal-activity", { terminalId: "t1", state: "working" });
    window.__mock.emit("terminal-activity", { terminalId: "t2", state: "working" });
  });
  await wait(150);
  let lines = await metaLines(page);
  checks["muestra Working para un agente en actividad"] = lines[0]?.includes("Working") ?? false;
  checks["muestra el tiempo que lleva corriendo el agente"] = /12m/.test(lines[0] ?? "");
  checks["una shell sin agente no muestra actividad"] = lines[1] === null;

  await page.evaluate(() =>
    window.__mock.emit("terminal-activity", { terminalId: "t1", state: "idle" }),
  );
  await wait(150);
  lines = await metaLines(page);
  checks["working -> idle sin foco pide atención"] = lines[0]?.includes("Needs attention") ?? false;
  checks["la atención se resalta distinto"] = (await page.$$(".thread-meta--attention")).length === 1;

  await page.$$eval(".thread-item:not(.thread-item--sub)", (els) => els[0].click());
  await wait(150);
  lines = await metaLines(page);
  checks["enfocar la terminal limpia la atención"] =
    (lines[0]?.includes("Idle") ?? false) && !lines[0].includes("Needs attention");

  await page.evaluate(() => {
    window.__mock.emit("terminal-activity", { terminalId: "t1", state: "working" });
  });
  await wait(100);
  await page.evaluate(() =>
    window.__mock.emit("terminal-activity", { terminalId: "t1", state: "idle" }),
  );
  await wait(150);
  lines = await metaLines(page);
  checks["idle con la terminal enfocada no pide atención"] =
    (lines[0]?.includes("Idle") ?? false) && !lines[0].includes("Needs attention");

  await page.evaluate(() =>
    window.__mock.emit("terminal-agent", { terminalId: "t1", agents: [] }),
  );
  await wait(150);
  checks["el tiempo corriendo sigue visible en idle"] = /12m/.test(lines[0] ?? "");

  // El contador avanza solo, sin nuevos eventos del núcleo.
  await page.evaluate(() => {
    const startedAt = Math.floor(Date.now() / 1000) - 58;
    window.__mock.emit("terminal-agent", { terminalId: "t1", agents: ["claude-code"], startedAt });
  });
  await wait(100);
  const before = (await metaLines(page))[0] ?? "";
  await wait(3200);
  const after = (await metaLines(page))[0] ?? "";
  checks["el tiempo corriendo se actualiza en vivo"] =
    /5\ds/.test(before) && /1m/.test(after);

  await page.evaluate(() =>
    window.__mock.emit("terminal-agent", { terminalId: "t1", agents: [], startedAt: null }),
  );
  await wait(150);
  checks["sin agente detectado desaparece la actividad"] = (await metaLines(page))[0] === null;
}
