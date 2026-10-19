// Regresión de R4-load-error-destroys-snapshot: si el núcleo falla al cargar
// el snapshot, la app sigue con la estructura default pero NO debe habilitar
// el guardado; de lo contrario la primera mutación pisa el archivo válido.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function snapshotLoadError(page, checks) {
  const base = page.url().split("?")[0];
  await page.goto(`${base}?mockSnapshotLoadError=1`, { waitUntil: "networkidle0" });
  await wait(300);

  checks["el fallo de carga deja la estructura default"] =
    (await page.$$(".pane:not([hidden])")).length === 1;

  // Primera mutación estructural después del fallo: abrir otra terminal.
  await page.click(".topbar .btn--primary");
  await wait(300);

  checks["una mutación posterior al fallo no persiste el default"] =
    (await page.evaluate(() => window.__mock.savedSnapshot)) === null;

  // Sin el fallo inyectado, la persistencia vuelve a funcionar en la carga siguiente.
  await page.goto(base, { waitUntil: "networkidle0" });
  await wait(300);
  await page.click(".topbar .btn--primary");
  await wait(300);
  checks["sin el fallo, la mutación vuelve a persistir"] =
    (await page.evaluate(() => window.__mock.savedSnapshot)) !== null;
}
