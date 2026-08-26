import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const ORCHESTRATOR_PORT = process.env.ORCHESTRATOR_PORT ?? "8787";

export default defineConfig({
  // tsconfig `paths` only informs the type checker; Vite needs its own alias.
  resolve: {
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 3000,
    proxy: {
      // Keeps the browser same-origin, so no CORS and no env juggling in dev.
      // Follows ORCHESTRATOR_PORT so a second instance can be run alongside
      // the default one without editing this file.
      "/api": { target: `http://localhost:${ORCHESTRATOR_PORT}`, changeOrigin: true },
      "/ws": { target: `ws://localhost:${ORCHESTRATOR_PORT}`, ws: true },
    },
  },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
});
