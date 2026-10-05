import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Puerto fijo: tauri.conf.json apunta devUrl a http://localhost:1420.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
