// The status bar shows real state: it starts honest (relay not connected, one
// collaborator) and follows the `collab-status` events the core emits.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const statusText = (page) => page.$$eval(".statusbar-item", (els) => els.map((e) => e.textContent.trim()));

export default async function statusBarLive(page, checks) {
  await wait(200);
  let [relay, collaborators] = await statusText(page);
  checks["arranca desconectado: 'Local · relay no conectado'"] = relay === "Local · relay no conectado";
  checks["arranca con '1 collaborator'"] = collaborators === "1 collaborator";

  await page.evaluate(() =>
    window.__mock.emit("collab-status", { connected: true, syncMs: 37, collaborators: 3 }),
  );
  await wait(100);
  [relay, collaborators] = await statusText(page);
  checks["conectado muestra 'Connected · sync 37ms'"] = relay === "Connected · sync 37ms";
  checks["muestra '3 collaborators'"] = collaborators === "3 collaborators";
  checks["el punto pasa a conectado"] = (await page.$(".statusbar .dot--connected")) !== null;

  await page.evaluate(() =>
    window.__mock.emit("collab-status", { connected: false, syncMs: null, collaborators: 1 }),
  );
  await wait(100);
  [relay] = await statusText(page);
  checks["vuelve a 'Local · relay no conectado' si el relay se cae"] = relay === "Local · relay no conectado";
}
