import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../");

// Production must serve the same header from the reverse proxy (see AGENTS.md).
// Not applied to the dev server: React Fast Refresh needs an inline script there.
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export default defineConfig(({ mode }) => {
  // Same-origin with the API: /auth is proxied to the server, so the httpOnly
  // refresh cookie (Path=/auth) works and no CORS is needed.
  const env = loadEnv(mode, rootDir, "");
  const api =
    process.env.OPENCOLLAB_API ??
    env.OPENCOLLAB_API ??
    (env.RELAY_ADDR ? `http://${env.RELAY_ADDR}` : undefined) ??
    "http://127.0.0.1:8787";
  const proxy = { "/auth": { target: api, changeOrigin: false } };

  return {
    plugins: [react()],
    clearScreen: false,
    // No inlined data: URIs, so the CSP can keep font-src 'self'.
    build: { assetsInlineLimit: 0 },
    server: { port: 1421, strictPort: true, proxy },
    preview: {
      port: 1421,
      strictPort: true,
      proxy,
      headers: { "Content-Security-Policy": CSP },
    },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}"],
      restoreMocks: true,
    },
  };
});
