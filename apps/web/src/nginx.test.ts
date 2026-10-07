// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CSP } from "../vite.config";

// Guard against drift: production (nginx) must send the same CSP as `vite preview`.
const conf = readFileSync(resolve(__dirname, "../nginx.conf"), "utf8");

function header(name: string): string | undefined {
  return new RegExp(String.raw`add_header\s+${name}\s+"([^"]*)"\s+always;`).exec(conf)?.[1];
}

describe("nginx.conf", () => {
  it("sends the same Content-Security-Policy as vite preview", () => {
    expect(header("Content-Security-Policy")).toBe(CSP);
  });

  it("proxies /auth and /ws to the server with websocket upgrade", () => {
    expect(conf).toMatch(/location \/auth\//);
    expect(conf).toMatch(/location \/ws/);
    expect(conf).toMatch(/proxy_set_header\s+Upgrade\s+\$http_upgrade/);
  });

  it("falls back to index.html for SPA routes", () => {
    expect(conf).toMatch(/try_files\s+\$uri\s+\/index\.html/);
  });
});
