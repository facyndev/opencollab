// Árbol de subagentes en el hilo de terminales y panel de configuración de hooks con confirmación.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function subagentsAndHooks(page, checks) {
  // Abrimos una segunda terminal para tener t1 y t2, y poder verificar que
  // hacer clic en un subagente de t1 enfoca t1 aun cuando t2 estaba enfocada.
  await page.click(".topbar .btn--primary");
  await wait(400);

  // Aseguramos que t2 esté enfocada inicialmente
  await page.evaluate(() => {
    const panes = document.querySelectorAll(".pane:not([hidden])");
    panes[1]?.click();
  });
  await wait(100);

  // Emitir terminal-subagents para t1 con un subagente raíz (corriendo) y uno anidado (terminado).
  await page.evaluate(() =>
    window.__mock.emit("terminal-subagents", {
      terminalId: "t1",
      subagents: [
        {
          id: "sub-1",
          parentId: null,
          agent: "claude-code",
          kind: "task",
          label: "Task: test runner",
          status: "running",
        },
        {
          id: "sub-2",
          parentId: "sub-1",
          agent: "claude-code",
          kind: "task",
          label: "Task: unit tests",
          status: "completed",
        },
      ],
    }),
  );
  await wait(200);

  // Verificamos etiquetas y clases de los subagentes en el hilo
  const subLabels = await page.$$eval(".thread-item--sub .thread-label", (els) =>
    els.map((e) => e.textContent),
  );
  checks["se muestran los subagentes en el hilo con sus etiquetas"] =
    subLabels.includes("Task: test runner") && subLabels.includes("Task: unit tests");

  checks["los subagentes tienen la clase thread-item--sub"] = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".thread-item--sub")];
    return items.length >= 2;
  });

  checks["los puntos de estado reflejan running y completed (done)"] = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".thread-item--sub")];
    const root = items.find((e) => e.querySelector(".thread-label")?.textContent === "Task: test runner");
    const child = items.find((e) => e.querySelector(".thread-label")?.textContent === "Task: unit tests");
    const rootRunning = Boolean(root && root.querySelector(".dot--running"));
    const childDone = Boolean(child && child.querySelector(".dot--done"));
    return rootRunning && childDone;
  });

  // Verificamos que el subagente anidado cuelga dentro de su contenedor anidado (<ul class="thread--sub">)
  checks["el subagente anidado cuelga dentro de su contenedor anidado"] = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".thread-item--sub")];
    const child = items.find((e) => e.querySelector(".thread-label")?.textContent === "Task: unit tests");
    if (!child) return false;
    const innerUl = child.closest(".thread--sub");
    if (!innerUl) return false;
    const parentLi = innerUl.closest("li");
    const parentBtn = parentLi?.querySelector(".thread-item--sub");
    return parentBtn?.querySelector(".thread-label")?.textContent === "Task: test runner";
  });

  // Clic en el subagente enfoca la terminal t1
  await page.evaluate(() => {
    const items = [...document.querySelectorAll(".thread-item--sub")];
    const child = items.find((e) => e.querySelector(".thread-label")?.textContent === "Task: unit tests");
    child?.click();
  });
  await wait(150);

  checks["clic en el subagente enfoca la terminal que lo contiene"] = await page.$$eval(
    ".pane:not([hidden])",
    (els) => els[0].classList.contains("pane--focused") && !els[1].classList.contains("pane--focused"),
  );

  // 2. Modal de Settings
  await page.click('button[title="Settings"]');
  await page.waitForSelector(".settings-modal");
  checks["se abre el modal de Settings al hacer clic en el botón"] =
    (await page.$(".settings-modal")) !== null;

  // Estados de los agentes listados
  checks["se listan los estados de los agentes (Claude Code notInstalled, Antigravity unsupported)"] =
    await page.evaluate(() => {
      const claude = document.querySelector('[data-agent="claude-code"]');
      const antigravity = document.querySelector('[data-agent="antigravity-cli"]');
      const claudeBadge = claude?.querySelector(".badge")?.textContent?.trim();
      const agBadge = antigravity?.querySelector(".badge")?.textContent?.trim();
      const agHasButton = antigravity?.querySelector("button") !== null;
      return claudeBadge === "No instalado" && agBadge === "No soportado" && !agHasButton;
    });

  // Clic en Instalar en Claude Code -> aparece diálogo de confirmación
  await page.click('[data-agent="claude-code"] button');
  await page.waitForSelector(".modal-confirm");
  checks["al hacer clic en Instalar aparece el diálogo de confirmación"] =
    (await page.$(".modal-confirm")) !== null;

  checks["no se invoca install_agent_hooks antes de confirmar"] =
    (await page.evaluate(() => window.__mock.hookCalls.length)) === 0;

  // Confirmar la instalación
  await page.click(".modal-confirm button.btn--primary");
  await page.waitForSelector(".modal-confirm", { hidden: true });
  await wait(150);

  checks["al confirmar se invoca install_agent_hooks en el mock"] = await page.evaluate(() => {
    const last = window.__mock.hookCalls.at(-1);
    return last?.cmd === "install_agent_hooks" && last?.agent === "claude-code";
  });

  checks["cambia el estado a instalado con botón Desinstalar"] = await page.evaluate(() => {
    const claude = document.querySelector('[data-agent="claude-code"]');
    const badge = claude?.querySelector(".badge")?.textContent?.trim();
    const btn = claude?.querySelector("button")?.textContent?.trim();
    return badge === "Instalado" && btn === "Desinstalar";
  });

  // Clic en Desinstalar -> diálogo de confirmación
  await page.click('[data-agent="claude-code"] button');
  await page.waitForSelector(".modal-confirm");
  checks["al hacer clic en Desinstalar aparece el diálogo de confirmación"] =
    (await page.$(".modal-confirm")) !== null;

  // Confirmar la desinstalación
  await page.click(".modal-confirm button.btn--primary");
  await page.waitForSelector(".modal-confirm", { hidden: true });
  await wait(150);

  checks["al confirmar se invoca uninstall_agent_hooks en el mock"] = await page.evaluate(() => {
    const last = window.__mock.hookCalls.at(-1);
    return last?.cmd === "uninstall_agent_hooks" && last?.agent === "claude-code";
  });

  checks["vuelve a estado no instalado tras desinstalar"] = await page.evaluate(() => {
    const claude = document.querySelector('[data-agent="claude-code"]');
    const badge = claude?.querySelector(".badge")?.textContent?.trim();
    const btn = claude?.querySelector("button")?.textContent?.trim();
    return badge === "No instalado" && btn === "Instalar";
  });

  // Cierre del modal con tecla Escape
  await page.keyboard.press("Escape");
  await wait(150);
  checks["se cierra el modal con tecla Escape"] =
    (await page.$(".settings-modal")) === null;

  // Abrir de nuevo y cerrar con el botón de cierre (✕)
  await page.click('button[title="Settings"]');
  await page.waitForSelector(".settings-modal");
  await page.click(".modal-close");
  await wait(150);
  checks["se cierra el modal con el botón de cierre (✕)"] =
    (await page.$(".settings-modal")) === null;
}
