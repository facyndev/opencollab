// Cambio de modo local → cloud (S4, A4): migra los workspaces, sesiones y
// terminales locales a la cuenta cloud sin borrar los que la cuenta ya tenía,
// y conserva intacto el archivo local.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const preExistingCloud = {
  version: 1,
  workspaces: [
    {
      id: "w-cloud-existing",
      name: "Equipo Cloud",
      sessions: [
        {
          id: "s-cloud-existing",
          name: "Sesión compartida",
          panes: [{ id: "p-cloud-1", seq: 0, minimized: false, initialCwd: null, agent: null }],
        },
      ],
    },
  ],
};

export default async function localToCloudMigration(page, checks) {
  await wait(300);

  // Creamos un segundo workspace en modo local para verificar que viaja toda
  // la estructura local al cambiar a Cloud.
  await page.click(".ws-current");
  await wait(150);
  await page.click(".ws-menu-new");
  await wait(300);

  const localBeforeSwitch = await page.evaluate(() => window.__mock.localSnapshot);
  checks["en modo local se persisten los workspaces creados"] =
    Array.isArray(localBeforeSwitch?.workspaces) && localBeforeSwitch.workspaces.length === 2;

  // La cuenta cloud ya tiene un workspace previo ("Equipo Cloud").
  await page.evaluate((cloud) => {
    window.__mock.setCloudSnapshot(cloud);
    window.__mock.signIn();
  }, preExistingCloud);
  await wait(200);

  await page.click('button[aria-label="Settings"]');
  await wait(200);
  await page.evaluate(() => {
    const [, cloud] = document.querySelectorAll(".settings-mode input");
    cloud.click();
  });
  await wait(100);

  checks["Settings avisa que los datos locales se migran y el archivo local se conserva"] =
    await page.evaluate(() => {
      const hint = document.querySelector(".settings-hint")?.textContent ?? "";
      return hint.includes("migrated to your cloud account") && hint.includes("Local files are kept");
    });

  await page.click(".modal-actions .btn--primary");
  await wait(500);

  const afterMigration = await page.evaluate(() => ({
    mode: window.__mock.storageConfig.mode,
    localWorkspaces: window.__mock.localSnapshot?.workspaces?.map((w) => w.name) ?? [],
    cloudWorkspaces: window.__mock.cloudSnapshot?.workspaces?.map((w) => w.name) ?? [],
  }));

  checks["el cambio pasa a modo cloud"] = afterMigration.mode === "cloud";
  checks["la nube conserva su workspace previo y suma los migrados desde local"] =
    afterMigration.cloudWorkspaces.includes("Equipo Cloud") &&
    afterMigration.cloudWorkspaces.includes("OpenCollab") &&
    afterMigration.cloudWorkspaces.includes("Workspace 2");
  checks["el archivo local se conserva intacto tras la migración (A4)"] =
    afterMigration.localWorkspaces.length === 2 &&
    afterMigration.localWorkspaces.includes("OpenCollab") &&
    afterMigration.localWorkspaces.includes("Workspace 2");
}
