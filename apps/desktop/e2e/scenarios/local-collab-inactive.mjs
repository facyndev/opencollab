// Modo local (S3): la colaboración sigue visible en TopBar, Sidebar y
// StatusBar pero permanece inactiva hasta cambiar a almacenamiento Cloud.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function localCollabInactive(page, checks) {
  await wait(300);

  const initial = await page.evaluate(() => {
    const invite = [...document.querySelectorAll(".topbar-actions button")].find((b) =>
      b.textContent.includes("Invite"),
    );
    const wsMeta = document.querySelector(".sidebar .ws-meta");
    const userCard = document.querySelector(".sidebar .user");
    const statusItems = [...document.querySelectorAll(".statusbar-item")];
    return {
      inviteVisible: !!invite && invite.offsetParent !== null,
      inviteDisabled: invite instanceof HTMLButtonElement && invite.disabled,
      inviteInactive: invite?.getAttribute("data-collab-inactive") === "true",
      inviteTitle: invite?.getAttribute("title") ?? "",
      wsMetaVisible: !!wsMeta && wsMeta.offsetParent !== null,
      wsMetaInactive: wsMeta?.getAttribute("data-collab-inactive") === "true",
      userVisible: !!userCard && userCard.offsetParent !== null,
      userInactive: userCard?.getAttribute("data-collab-inactive") === "true",
      userText: userCard?.textContent ?? "",
      statusCount: statusItems.length,
      statusInactive: statusItems.every((el) => el.getAttribute("data-collab-inactive") === "true"),
      statusTexts: statusItems.map((el) => el.textContent.trim()),
    };
  });

  checks["Invite sigue visible pero deshabilitado en modo local"] =
    initial.inviteVisible && initial.inviteDisabled && initial.inviteInactive;
  checks["Invite explica que el modo local no invita"] = initial.inviteTitle.includes("Modo local");
  checks["el contador de miembros del workspace sigue visible e inactivo"] =
    initial.wsMetaVisible && initial.wsMetaInactive;
  checks["la tarjeta de cuenta indica colaboración inactiva en modo local"] =
    initial.userVisible &&
    initial.userInactive &&
    initial.userText.includes("Colaboración inactiva en modo local");
  checks["la status bar mantiene visibles los indicadores en estado inactivo"] =
    initial.statusCount === 2 &&
    initial.statusInactive &&
    initial.statusTexts[0] === "Local · relay no conectado" &&
    initial.statusTexts[1] === "1 collaborator";

  // Incluso con sesión iniciada, el modo local no aparece como Online.
  await page.evaluate(() => window.__mock.signIn());
  await wait(200);
  const signedInLocal = await page.evaluate(() => ({
    userText: document.querySelector(".sidebar .user")?.textContent ?? "",
    userInactive:
      document.querySelector(".sidebar .user")?.getAttribute("data-collab-inactive") === "true",
  }));
  checks["con cuenta iniciada en modo local muestra colaboración inactiva (no Online)"] =
    signedInLocal.userInactive &&
    signedInLocal.userText.includes("Local · colaboración inactiva") &&
    !signedInLocal.userText.includes("Online");

  // Cambiar a Cloud en Settings activa los indicadores de colaboración.
  await page.click('button[aria-label="Settings"]');
  await wait(200);
  await page.evaluate(() => {
    const [, cloud] = document.querySelectorAll(".settings-mode input");
    cloud.click();
  });
  await wait(100);
  await page.click(".modal-actions .btn--primary");
  await wait(400);

  const inCloud = await page.evaluate(() => {
    const invite = [...document.querySelectorAll(".topbar-actions button")].find((b) =>
      b.textContent.includes("Invite"),
    );
    const userCard = document.querySelector(".sidebar .user");
    const wsMeta = document.querySelector(".sidebar .ws-meta");
    return {
      inviteInactive: invite?.getAttribute("data-collab-inactive"),
      inviteTitle: invite?.getAttribute("title") ?? "",
      userInactive: userCard?.getAttribute("data-collab-inactive"),
      userText: userCard?.textContent ?? "",
      wsMetaInactive: wsMeta?.getAttribute("data-collab-inactive"),
    };
  });
  checks["al pasar a Cloud la colaboración deja de figurar inactiva"] =
    inCloud.inviteInactive === null &&
    inCloud.userInactive === null &&
    inCloud.wsMetaInactive === null &&
    inCloud.userText.includes("Online") &&
    inCloud.inviteTitle.includes("Requiere el relay");
}
