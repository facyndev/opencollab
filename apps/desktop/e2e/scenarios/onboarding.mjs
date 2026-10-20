// Primera corrida: sin configuración completa la app muestra el onboarding y
// no monta la grilla. Elegir local persiste el modo y crea el snapshot default.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function onboarding(page, checks) {
  const base = page.url().split("?")[0];
  await page.goto(`${base}?mockFirstRun=1`, { waitUntil: "networkidle0" });
  await wait(300);

  checks["la primera corrida muestra el onboarding"] = (await page.$(".onboarding")) !== null;
  checks["el onboarding reemplaza la grilla"] = (await page.$(".app")) === null;

  const clicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll(".onboarding-mode")].find((b) =>
      b.textContent.includes("Local"),
    );
    if (button) button.click();
    return !!button;
  });
  checks["ofrece elegir almacenamiento local"] = clicked;
  await wait(500);

  checks["elegir local entra a la app"] = (await page.$(".app")) !== null;
  checks["persiste el modo local"] = await page.evaluate(
    () => window.__mock.storageConfig.onboardingComplete && window.__mock.storageConfig.mode === "local",
  );
  checks["crea el snapshot default"] =
    (await page.evaluate(() => window.__mock.savedSnapshot)) !== null;
}
