// La cuenta local está fija en el código hasta que exista autenticación: se
// oculta en la interfaz (sin quitarla del marcado) para no mostrar un usuario
// que no es el real.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/// `true` si hay al menos un elemento que coincide con `selector` y ninguno se
/// ve en pantalla (sin elementos, el chequeo no probaría nada).
const allHidden = (page, selector) =>
  page.evaluate((selector) => {
    const els = [...document.querySelectorAll(selector)];
    return els.length > 0 && els.every((el) => el.offsetParent === null);
  }, selector);

/// `true` si el elemento existe en el DOM (se oculta, no se elimina).
const exists = (page, selector) =>
  page.evaluate((selector) => document.querySelector(selector) !== null, selector);

export default async function hiddenAccount(page, checks) {
  await wait(300);

  checks["la tarjeta de usuario del sidebar sigue en el DOM"] = await exists(page, ".sidebar .user");
  checks["la tarjeta de usuario del sidebar no se ve"] = await allHidden(page, ".sidebar .user");
  checks["el avatar del topbar no se ve"] = await allHidden(page, ".topbar-actions .avatars");
  checks["el avatar host de cada panel no se ve"] = await allHidden(page, ".pane .avatar--me");
}
