// Arrastrar una terminal sobre otra: se intercambian en vivo, animadas, sin
// reordenar el DOM (las instancias de xterm no se mueven).
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const snapshot = (page) =>
  page.$$eval("section.pane:not([hidden])", (els) =>
    els.map((el, dom) => {
      el.dataset.dom ??= String(dom); // marca estable del nodo DOM
      const r = el.getBoundingClientRect();
      return {
        dom: el.dataset.dom,
        x: Math.round(r.left),
        y: Math.round(r.top),
        computed: getComputedStyle(el).transform, // incluye transiciones en curso
      };
    }),
  );

export default async function dragSwap(page, checks) {
  for (let i = 0; i < 3; i++) {
    await page.click(".topbar .btn--primary");
    await wait(150);
  }
  const before = await snapshot(page);
  const slot = (list, dom) => list.find((p) => p.dom === dom);

  // Panel 0 (arriba a la izquierda) por su header hasta el centro del 3 (abajo a la derecha).
  const header = await (await page.$$("section.pane:not([hidden]) .pane-name"))[0].boundingBox();
  const target = await (await page.$$("section.pane:not([hidden])"))[3].boundingBox();
  const start = { x: header.x + 5, y: header.y + header.height / 2 };
  const end = { x: target.x + target.width / 2, y: target.y + target.height / 2 };

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  let animated = false;
  for (let i = 1; i <= 30; i++) {
    const t = i / 30;
    await page.mouse.move(start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t);
    await wait(25);
    const now = await snapshot(page);
    animated ||= now.some((p) => p.dom !== "0" && p.computed !== "none");
  }
  await page.mouse.up();
  await wait(500);
  const after = await snapshot(page);

  const dragged = slot(after, "0");
  const goal = slot(before, "3");
  checks["el arrastrado terminó en el lugar del destino"] = dragged.x === goal.x && dragged.y === goal.y;
  checks["los 4 lugares siguen ocupados sin superponerse"] =
    new Set(after.map((p) => `${p.x},${p.y}`)).size === 4 &&
    after.every((p) => before.some((b) => b.x === p.x && b.y === p.y));
  checks["los demás paneles se animaron"] = animated;
  checks["en reposo ningún panel queda desplazado"] = after.every((p) => p.computed === "none");
  checks["el DOM no se reordenó (xterm no se movió)"] = after.map((p) => p.dom).join() === "0,1,2,3";
}
