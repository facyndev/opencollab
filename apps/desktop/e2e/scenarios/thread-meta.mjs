// Hilo del sidebar: estado del agente junto al título (working / idle / needs
// attention), línea secundaria con herramienta y tiempo corriendo, y la rama de
// git como línea del hilo; todo agnóstico del agente.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const TOP = ".thread:not(.thread--sub) > li";

// Título de cada terminal del hilo (con el estado si corre un agente).
const titles = (page) =>
  page.$$eval(TOP, (items) =>
    items.map((li) => li.querySelector(":scope > .thread-item")?.textContent ?? ""),
  );

// Si el título muestra el punto de estado (terminal sin agente).
const hasDot = (page) =>
  page.$$eval(TOP, (items) =>
    items.map((li) => !!li.querySelector(":scope > .thread-item > .dot")),
  );

// Texto de la línea secundaria de cada terminal del hilo (null = sin línea).
const metaLines = (page) =>
  page.$$eval(TOP, (items) =>
    items.map((li) => li.querySelector(":scope > .thread-meta")?.textContent ?? null),
  );

// Rama de cada terminal, como línea del hilo (null = sin línea).
const branches = (page) =>
  page.$$eval(TOP, (items) =>
    items.map((li) => li.querySelector(":scope > .thread--sub .thread-branch")?.textContent ?? null),
  );

export default async function threadMeta(page, checks) {
  // El home es un repo en `main`; OneDrive, uno con HEAD desacoplado; el resto, no.
  await page.evaluate(() => {
    window.__mock.branches["C:\\Users\\facun"] = { name: "main", detached: false };
    window.__mock.branches["C:\\Users\\facun\\OneDrive"] = { name: "3f78685", detached: true };
  });
  await page.click(".topbar .btn--primary"); // t2, queda enfocada
  await wait(400);

  // t1 (sin foco) corre un agente; t2 es solo una shell.
  await page.evaluate(() => {
    // Arrancó hace 12 minutos (el núcleo informa segundos desde la época Unix).
    const startedAt = Math.floor(Date.now() / 1000) - 12 * 60;
    window.__mock.emit("terminal-agent", { terminalId: "t1", agents: ["claude-code"], startedAt });
    window.__mock.agentState("t1", { status: "working" });
    window.__mock.agentState("t2", { status: "working" });
  });
  await wait(150);
  let lines = await metaLines(page);
  let heads = await titles(page);
  let dots = await hasDot(page);
  let refs = await branches(page);
  checks["muestra Working junto al título del agente"] = heads[0]?.includes("Claude Code · Working") ?? false;
  checks["con agente el estado reemplaza al punto"] = dots[0] === false;
  checks["el estado ya no va en la línea secundaria"] = !/Working/.test(lines[0] ?? "");
  checks["muestra el tiempo que lleva corriendo el agente"] = /12m/.test(lines[0] ?? "");
  checks["una shell sin agente no muestra estado en el título"] =
    !/Working|Idle|Needs|·/.test(heads[1] ?? "");
  checks["una shell sin agente conserva el punto"] = dots[1] === true;
  checks["una shell sin agente muestra la rama de su carpeta"] = refs[1]?.includes("main") ?? false;
  checks["la rama cuelga del hilo como las de agentes anidados"] =
    (await page.$$(".thread--sub .thread-branch")).length >= 1;

  await page.evaluate(() =>
    window.__mock.agentState("t1", { status: "idle" }),
  );
  await wait(150);
  heads = await titles(page);
  refs = await branches(page);
  checks["working -> idle sin foco pide atención"] = heads[0]?.includes("Needs attention") ?? false;
  checks["al quedar inactiva se vuelve a leer la rama"] = refs[0]?.includes("main") ?? false;
  checks["la atención se resalta distinto"] = (await page.$$(".thread-state--attention")).length === 1;

  await page.$$eval(".thread-item:not(.thread-item--sub)", (els) => els[0].click());
  await wait(150);
  heads = await titles(page);
  checks["enfocar la terminal limpia la atención"] =
    heads[0].includes("Idle") && !heads[0].includes("Needs attention");

  await page.evaluate(() => {
    window.__mock.agentState("t1", { status: "working" });
  });
  await wait(100);
  await page.evaluate(() =>
    window.__mock.agentState("t1", { status: "idle" }),
  );
  await wait(150);
  heads = await titles(page);
  checks["idle con la terminal enfocada no pide atención"] =
    heads[0].includes("Idle") && !heads[0].includes("Needs attention");

  await page.evaluate(() =>
    window.__mock.emit("terminal-agent", { terminalId: "t1", agents: [] }),
  );
  await wait(150);
  lines = await metaLines(page);
  checks["sin agente desaparece el tiempo corriendo"] = lines[0] === null;

  // Estado rico (adaptador): herramienta en curso, aprobación pendiente y error.
  await page.evaluate(() => {
    window.__mock.emit("terminal-agent", {
      terminalId: "t1",
      agents: ["claude-code"],
      startedAt: Math.floor(Date.now() / 1000) - 12 * 60,
    });
    window.__mock.agentState("t1", { status: "working", tool: { name: "Bash", input: "echo hi" } });
  });
  await wait(150);
  lines = await metaLines(page);
  checks["muestra la herramienta en curso"] = lines[0]?.includes("Bash: echo hi") ?? false;

  await page.evaluate(() =>
    window.__mock.agentState("t1", {
      status: "working",
      tool: { name: "Bash", input: "rm -rf build" },
      approval: { requestId: "r1", description: "run rm -rf build" },
    }),
  );
  await wait(150);
  heads = await titles(page);
  checks["muestra la aprobación pendiente con su descripción"] =
    heads[0].includes("Needs approval: run rm -rf build");
  checks["la aprobación se resalta con el acento"] =
    (await page.$$(".thread-state--approval")).length === 1;

  await page.evaluate(() =>
    window.__mock.agentState("t1", { status: "idle", error: "exited with code 2" }),
  );
  await wait(150);
  heads = await titles(page);
  lines = await metaLines(page);
  checks["muestra el error"] = heads[0].includes("Error");
  checks["el detalle del error va en la línea secundaria"] =
    lines[0]?.includes("exited with code 2") ?? false;
  checks["el error se marca distinto"] = (await page.$$(".thread-state--error")).length === 1;

  await page.evaluate(() => window.__mock.agentState("t1", { status: "idle", completed: true }));
  await wait(150);
  heads = await titles(page);
  lines = await metaLines(page);
  checks["tras completar vuelve a Idle y conserva el tiempo"] =
    heads[0].includes("Idle") && /12m/.test(lines[0] ?? "");

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
  heads = await titles(page);
  lines = await metaLines(page);
  refs = await branches(page);
  dots = await hasDot(page);
  checks["sin agente detectado vuelve el punto y desaparece el estado"] =
    dots[0] === true && !/Working|Idle|Needs|·/.test(heads[0]) && lines[0] === null;
  checks["sin agente detectado queda la rama"] = refs[0]?.includes("main") ?? false;

  // Cambiar de carpeta (OSC 7) actualiza la rama: HEAD desacoplado y fuera de un repo.
  await page.evaluate(() => window.__mock.prompt("t2", "C:\\Users\\facun\\OneDrive"));
  await wait(200);
  refs = await branches(page);
  checks["HEAD desacoplado muestra el SHA corto"] = refs[1]?.includes("3f78685") ?? false;
  await page.evaluate(() => window.__mock.prompt("t2", "C:\\Users"));
  await wait(200);
  checks["fuera de un repositorio no se muestra nada"] = (await branches(page))[1] === null;
}
