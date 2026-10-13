// Abrir una terminal desde otra: en la misma carpeta o en la por defecto, y al
// lado de la terminal de origen.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const HOME = "C:\\Users\\facun";
const ONEDRIVE = "C:\\Users\\facun\\OneDrive";

/// Rutas de los paneles visibles, en orden visual (propiedad CSS `order`).
const visualCwds = (page) =>
  page.$$eval(".pane:not([hidden])", (els) =>
    els
      .map((el) => ({ order: Number(el.style.order), cwd: el.querySelector(".cwd-path")?.textContent }))
      .sort((a, b) => a.order - b.order)
      .map((p) => p.cwd),
  );

async function openFrom(page, paneIndex, label) {
  await page.$$eval(".pane:not([hidden]) .new-terminal-btn", (els, i) => els[i].click(), paneIndex);
  await page.waitForSelector(".new-terminal-menu");
  await page.$$eval(
    ".new-terminal-menu button.cwd-item",
    (els, label) => els.find((e) => e.textContent.includes(label)).click(),
    label,
  );
  await wait(300);
}

export default async function newTerminalHere(page, checks) {
  // La shell de t1 hace `cd OneDrive` (como lo reportaría con OSC 7).
  await page.evaluate((path) => {
    const data = [...new TextEncoder().encode(`\x1b]7;file://localhost/${path.replace(/\\/g, "/")}\x1b\\`)];
    window.__mock.emit("terminal-output", { terminalId: "t1", data });
  }, ONEDRIVE);
  await wait(150);

  await page.click(".topbar .btn--primary"); // t2, en el home, al final
  await wait(300);

  await openFrom(page, 0, "In this folder");
  const here = await page.evaluate(() => window.__mock.opened.at(-1));
  checks["en esta carpeta: open_shell recibe la ruta de la terminal de origen"] = here?.cwd === ONEDRIVE;
  checks["en esta carpeta: arranca ahí y queda al lado de la de origen"] =
    JSON.stringify(await visualCwds(page)) === JSON.stringify([ONEDRIVE, ONEDRIVE, HOME]);
  checks["la terminal nueva queda enfocada"] = await page.$$eval(
    ".pane:not([hidden])",
    (els) => els.filter((e) => e.classList.contains("pane--focused")).length === 1 &&
      els[2].classList.contains("pane--focused"),
  );

  await openFrom(page, 0, "In the default folder");
  checks["carpeta por defecto: open_shell sin ruta"] =
    (await page.evaluate(() => window.__mock.opened.at(-1).cwd)) === null;
  checks["carpeta por defecto: arranca en el home, al lado de la de origen"] =
    JSON.stringify(await visualCwds(page)) === JSON.stringify([ONEDRIVE, HOME, ONEDRIVE, HOME]);

  // Atajo: Ctrl+Shift+T con la terminal 1 enfocada.
  await page.$$eval(".pane:not([hidden]) .pane-body", (els) =>
    els[0].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
  );
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("T");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await wait(300);
  checks["Ctrl+Shift+T abre en la carpeta de la terminal enfocada"] =
    (await page.evaluate(() => window.__mock.opened.at(-1).cwd)) === ONEDRIVE &&
    (await page.$$(".pane:not([hidden])")).length === 5;
}
