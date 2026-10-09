// Login del desktop vía la web: anónimo ofrece Sign in (ya no hay cuenta local
// fija oculta); al tocarlo espera el regreso del navegador, y el evento
// `auth-changed` del núcleo muestra el usuario real.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const visible = (page, selector) =>
  page.evaluate(
    (selector) => document.querySelector(selector) !== null && document.querySelector(selector).offsetParent !== null,
    selector,
  );

const buttonByText = (page, text) =>
  page.evaluate((text) => {
    const btn = [...document.querySelectorAll(".sidebar .user button")].find((b) =>
      b.textContent.includes(text),
    );
    if (btn) btn.click();
    return !!btn;
  }, text);

export default async function authSignin(page, checks) {
  await wait(300);

  checks["la tarjeta de cuenta se ve"] = await visible(page, ".sidebar .user");
  checks["ofrece Sign in"] = await page.evaluate(
    () => [...document.querySelectorAll(".sidebar .user button")].some((b) => b.textContent.includes("Sign in")),
  );

  await buttonByText(page, "Sign in");
  await wait(300);
  checks["espera el regreso del navegador"] = await page.evaluate(() =>
    document.querySelector(".sidebar .user")?.textContent.includes("Waiting for browser"),
  );
  checks["se puede cancelar el login"] = await page.evaluate(() =>
    [...document.querySelectorAll(".sidebar .user button")].some((b) => b.textContent.includes("Cancel")),
  );

  // El núcleo avisa el login con `auth-changed` (el deep link en la app real).
  await page.evaluate(() =>
    window.__mock.emit("auth-changed", {
      user: { id: "u1", username: "tester", email: null, displayName: "Tester" },
    }),
  );
  await wait(300);
  checks["muestra el usuario real"] = await page.evaluate(() =>
    document.querySelector(".sidebar .user")?.textContent.includes("Tester"),
  );
}
