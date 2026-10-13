// Lanzar un agente como perfil desde el menú "+" del header: el menú lista solo
// los agentes instalados y abrir uno crea un panel que le pide al núcleo ese agente.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const HOME = "C:\\Users\\facun";

const openMenu = async (page) => {
  await page.$eval(".pane:not([hidden]) .new-terminal-btn", (el) => el.click());
  await page.waitForSelector(".new-terminal-menu");
};

export default async function launchAgent(page, checks) {
  await wait(300); // la shell de t1 reporta su carpeta (OSC 7)
  await openMenu(page);
  const items = await page.$$eval(".new-terminal-agent", (els) =>
    els.map((e) => ({ id: e.dataset.agent, text: e.textContent })),
  );
  checks["el menú lista solo los agentes instalados"] =
    JSON.stringify(items.map((i) => i.id)) === JSON.stringify(["claude-code", "opencode", "codex"]);
  checks["cada agente se muestra con su nombre"] = items[0]?.text.includes("Claude Code") ?? false;

  await page.$eval('.new-terminal-agent[data-agent="claude-code"]', (el) => el.click());
  await wait(300);
  const launched = await page.evaluate(() => window.__mock.opened.at(-1));
  checks["abrir un agente crea otro panel"] = (await page.$$(".pane:not([hidden])")).length === 2;
  checks["open_shell recibe el id del agente"] = launched?.agent === "claude-code";
  checks["el agente arranca en la carpeta de la terminal de origen"] = launched?.cwd === HOME;
  checks["el menú se cierra al elegir"] = (await page.$(".new-terminal-menu")) === null;

  // El núcleo detecta el agente corriendo dentro de la shell de la terminal nueva.
  await page.evaluate(() =>
    window.__mock.emit("terminal-agent", { terminalId: "t2", agents: ["claude-code"], startedAt: null }),
  );
  await wait(150);
  const labels = await page.$$eval(".thread-label", (els) => els.map((e) => e.textContent));
  checks["el hilo muestra el agente lanzado"] = labels.includes("Claude Code");

  // Abrir una shell común sigue sin pedir agente.
  await openMenu(page);
  await page.$$eval(
    ".new-terminal-menu button.cwd-item",
    (els) => els.find((e) => e.textContent.includes("In the default folder")).click(),
  );
  await wait(300);
  checks["una shell común no pide agente"] =
    (await page.evaluate(() => window.__mock.opened.at(-1).agent)) === null;
}
