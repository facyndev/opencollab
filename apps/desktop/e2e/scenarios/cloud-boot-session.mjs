// Reinicio en modo cloud: la config persiste pero los tokens viven solo en
// memoria, así que sin login no se monta la grilla ni se guarda nada. Al
// iniciar sesión se carga el snapshot de la cuenta; logout vuelve al gate y el
// siguiente login lo recupera.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const cloudSnapshot = {
  version: 1,
  workspaces: [
    {
      id: "w-cloud",
      name: "Nube",
      sessions: [
        {
          id: "s-cloud",
          name: "Sesión nube",
          panes: [{ id: "p-cloud", seq: 0, minimized: false, initialCwd: null, agent: null }],
        },
      ],
    },
  ],
};

export default async function cloudBootSession(page, checks) {
  const base = page.url().split("?")[0];
  await page.goto(`${base}?mockCloud=1`, { waitUntil: "networkidle0" });
  await wait(300);

  checks["cloud sin sesión no monta la grilla"] = (await page.$(".app")) === null;
  checks["cloud sin sesión pide login"] = await page.evaluate(() =>
    document.body.textContent.includes("Sign in to load your workspace structure"),
  );
  checks["cloud sin sesión no guarda el default"] =
    (await page.evaluate(() => window.__mock.savedSnapshot)) === null;

  await page.evaluate((snapshot) => window.__mock.setSnapshot(snapshot), cloudSnapshot);
  await page.evaluate(() => window.__mock.signIn());
  await wait(600);

  checks["el login carga la nube"] = await page.evaluate(() =>
    document.body.textContent.includes("Nube"),
  );
  checks["la grilla usa el snapshot de la cuenta"] = await page.evaluate(
    () => window.__mock.savedSnapshot?.workspaces?.[0]?.id === "w-cloud",
  );

  await page.evaluate(() => window.__mock.signOut());
  await wait(300);
  checks["logout vuelve al gate"] =
    (await page.$(".app")) === null &&
    (await page.evaluate(() => document.body.textContent.includes("Sign in")));

  await page.evaluate(() => window.__mock.signIn());
  await wait(600);
  checks["re-login recupera la nube"] = await page.evaluate(() =>
    document.body.textContent.includes("Nube"),
  );
}
