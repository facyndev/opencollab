// When the shell process ends on its own (e.g. the user types `exit`), the pane
// closes exactly like with the ✕ button.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const visiblePanes = (page) => page.$$eval(".pane:not([hidden])", (els) => els.length);

export default async function exitClosesPane(page, checks) {
  await page.click(".topbar .btn--primary"); // t2
  await page.click(".topbar .btn--primary"); // t3
  await wait(300);
  checks["arranca con 3 terminales"] = (await visiblePanes(page)) === 3;

  // The shell of t1 exits by itself.
  await page.evaluate(() => window.__mock.emit("terminal-exit", { terminalId: "t1" }));
  await wait(200);
  checks["exit en la shell quita el panel de la grilla"] = (await visiblePanes(page)) === 2;
  checks["exit en la shell la cierra en el núcleo"] = await page.evaluate(() =>
    window.__mock.closed.includes("t1"),
  );

  // Closing from the UI: the core also emits terminal-exit afterwards, and only
  // that pane must go away.
  await page.$$eval(".pane:not([hidden]) .icon-btn[title='Close']", (els) => els[0].click());
  await wait(200);
  checks["cerrar con ✕ quita solo ese panel"] = (await visiblePanes(page)) === 1;
  checks["cerrar con ✕ llama a close_terminal una sola vez"] = await page.evaluate(
    () => window.__mock.closed.filter((id) => id === "t2").length === 1,
  );
}
