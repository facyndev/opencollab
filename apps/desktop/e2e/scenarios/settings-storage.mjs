// Settings: el engranaje del TopBar abre el modal y guardar persiste la base
// URL vía `storage_config_set`. Con sesión anónima, cloud queda bloqueado.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function settingsStorage(page, checks) {
  await wait(300);
  await page.click('button[aria-label="Settings"]');
  await wait(200);
  checks["el engranaje abre Settings"] = (await page.$(".modal")) !== null;
  checks["Settings muestra las dos opciones"] =
    (await page.$$(".settings-mode")).length === 2;

  await page.evaluate(() => {
    const input = document.querySelector(".settings-field input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "http://localhost:9999");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click(".modal-actions .btn--primary");
  await wait(400);

  checks["guardar persiste la base URL"] = await page.evaluate(
    () => window.__mock.storageConfig.apiBaseUrl === "http://localhost:9999",
  );
  checks["guardar cierra el modal"] = (await page.$(".modal")) === null;

  await page.click('button[aria-label="Settings"]');
  await wait(200);
  await page.evaluate(() => {
    const [, cloud] = document.querySelectorAll(".settings-mode input");
    cloud.click();
  });
  await wait(100);
  checks["cloud sin sesión no se puede guardar"] = await page.evaluate(() => {
    const save = document.querySelector(".modal-actions .btn--primary");
    return save instanceof HTMLButtonElement && save.disabled;
  });
}
