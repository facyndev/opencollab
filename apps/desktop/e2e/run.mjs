// Runner de los E2E de la interfaz: sirve el build de producción (`dist/`, hay
// que correr `pnpm build` antes), abre Chrome headless con el núcleo de Tauri
// simulado y corre cada escenario. Sale con código 1 si falla algún chequeo.
//
//     pnpm build && pnpm test:e2e
//
// Chrome: se usa el instalado en el sistema (o el de la variable CHROME_PATH).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { preview } from "vite";

import { installTauriMock } from "./tauri-mock.js";
import cwdAndThread from "./scenarios/cwd-and-thread.mjs";
import dragSwap from "./scenarios/drag-swap.mjs";
import exitClosesPane from "./scenarios/exit-closes-pane.mjs";
import statusBarLive from "./scenarios/status-bar-live.mjs";
import newTerminalHere from "./scenarios/new-terminal-here.mjs";
import subagentsAndHooks from "./scenarios/subagents-and-hooks.mjs";

const scenarios = {
  "drag & swap de terminales": dragSwap,
  "ruta, cambiador e hilo": cwdAndThread,
  "nueva terminal desde otra": newTerminalHere,
  "exit en la shell cierra el panel": exitClosesPane,
  "status bar con estado real": statusBarLive,
  "subagentes en el hilo y panel de hooks": subagentsAndHooks,
};

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error("No se encontró Chrome/Edge: definí CHROME_PATH");
  return found;
}

const root = fileURLToPath(new URL("..", import.meta.url));
if (!existsSync(`${root}/dist/index.html`)) {
  console.error("Falta dist/: corré `pnpm build` antes de los E2E.");
  process.exit(1);
}

const server = await preview({ root, preview: { port: 4173, strictPort: true, open: false } });
const url = "http://localhost:4173";
const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: true,
  defaultViewport: { width: 1440, height: 900 },
});

let failed = 0;
try {
  for (const [name, scenario] of Object.entries(scenarios)) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.evaluateOnNewDocument(installTauriMock);
    await page.goto(url, { waitUntil: "networkidle0" });

    console.log(`\n▶ ${name}`);
    const checks = {};
    try {
      await scenario(page, checks);
    } catch (e) {
      checks[`terminó sin excepciones (${e.message})`] = false;
    }
    checks["sin errores de JS"] = errors.length === 0;
    for (const [check, ok] of Object.entries(checks)) {
      console.log(`  ${ok ? "OK  " : "FAIL"} ${check}`);
      if (!ok) failed++;
    }
    if (errors.length) console.log(errors);
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

console.log(failed ? `\n${failed} chequeo(s) fallaron` : "\nTodos los E2E pasaron");
process.exit(failed ? 1 : 0);
