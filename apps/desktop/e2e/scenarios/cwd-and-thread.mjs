// Ruta del header (OSC 7), cambiador de ruta (adelante/atrás) e hilo de
// terminales del sidebar con detección de agentes.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const cwdOf = (page, i) =>
  page.$$eval(".pane:not([hidden]) .cwd-path", (els, i) => els[i]?.textContent, i);

async function openCwdMenu(page) {
  await page.click(".pane:not([hidden]) .cwd-button");
  await page.waitForSelector(".cwd-menu button.cwd-item");
  await wait(150); // las subcarpetas llegan asíncronas
}

const clickMenuItem = (page, text) =>
  page.$$eval(
    ".cwd-menu button.cwd-item",
    (els, text) => {
      const item = els.find((e) => e.querySelector(".cwd-item-path")?.textContent === text);
      if (!item) throw new Error(`no está "${text}" en el menú`);
      item.click();
    },
    text,
  );

export default async function cwdAndThread(page, checks) {
  await page.click(".topbar .btn--primary"); // segunda terminal
  await wait(400);

  checks["el header muestra la ruta que reporta la shell"] = (await cwdOf(page, 0)) === "C:\\Users\\facun";

  // Agente detectado en la terminal 2, con Codex anidado debajo.
  await page.evaluate(() => {
    window.__mock.emit("terminal-agent", {
      terminalId: "t2",
      agents: ["claude-code", "codex"],
    });
    window.__mock.emit("terminal-agent-session", {
      terminalId: "t2",
      title: "Fix authentication bug",
    });
  });
  await wait(200);
  const thread = await page.$$eval(".thread-label", (els) => els.map((e) => e.textContent));
  checks["el hilo lista las terminales con su shell/agente"] =
    thread.includes("PowerShell") && thread.includes("Claude Code") && thread.includes("Codex");
  checks["el hilo muestra el titulo de sesion del agente"] =
    thread.includes("Fix authentication bug");
  checks["el hilo muestra el logo del agente"] =
    (await page.$$(".thread-item .terminal-icon--logo")).length === 2;
  checks["el agente anidado cuelga de su terminal, en otro nivel"] = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".thread-item")];
    const codex = items.find((e) => e.textContent === "Codex");
    if (!codex) return false;
    // Vive dentro del <ul class="thread--sub"> que cuelga del <li> de su terminal.
    if (!codex.closest(".thread--sub")) return false;
    const owner = codex.closest("li").parentElement.closest("li");
    return !!owner && [...owner.querySelectorAll(".thread-item--sub")].includes(codex);
  });
  checks["el agente anidado abre la terminal que lo tiene"] = await page.evaluate(() => {
    const codex = [...document.querySelectorAll(".thread-item--sub")].find(
      (e) => e.textContent === "Codex",
    );
    if (!codex) return false;
    codex.click();
    return true;
  });
  await wait(100);
  checks["el clic en el agente anidado enfoca su terminal"] = await page.$$eval(
    ".pane:not([hidden])",
    (els) => els[1].classList.contains("pane--focused") && !els[0].classList.contains("pane--focused"),
  );
  checks["la ruta se bloquea mientras corre un agente"] = await page.$$eval(
    ".pane:not([hidden]) .cwd-button",
    (els) => els[1].disabled && !els[0].disabled,
  );

  await openCwdMenu(page);
  const items = await page.$$eval(".cwd-menu .cwd-item-path", (els) => els.map((e) => e.textContent));
  checks["menú: subcarpetas ordenadas (adelante)"] =
    JSON.stringify(items.slice(1, 5)) === JSON.stringify(["Desktop", "Documents", "OneDrive", ".cache"]);
  checks["menú: .. y directorios padre (atrás)"] =
    JSON.stringify(items.slice(5)) === JSON.stringify(["..", "C:\\Users", "C:\\"]);

  await clickMenuItem(page, "OneDrive");
  await wait(200);
  const last = await page.evaluate(() => window.__mock.writes.at(-1));
  checks["adelante: escribe Set-Location a la subcarpeta"] =
    last?.terminalId === "t1" && last.data === "Set-Location -LiteralPath 'C:\\Users\\facun\\OneDrive'\r";
  checks["adelante: el header se actualiza"] = (await cwdOf(page, 0)) === "C:\\Users\\facun\\OneDrive";

  await openCwdMenu(page);
  await clickMenuItem(page, "..");
  await wait(200);
  checks["atrás: .. vuelve a la carpeta padre"] = (await cwdOf(page, 0)) === "C:\\Users\\facun";

  await page.$$eval(".thread-item:not(.thread-item--sub)", (els) => els[1].click());
  await wait(100);
  checks["clic en el hilo enfoca esa terminal"] = await page.$$eval(
    ".pane:not([hidden])",
    (els) => els[1].classList.contains("pane--focused") && !els[0].classList.contains("pane--focused"),
  );
}
