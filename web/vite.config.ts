import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173 },
  plugins: [
    tailwindcss(),
    tanstackStart(), // must come before react()
    nitro(), // Node server output: node .output/server/index.mjs
    viteReact(),
  ],
});
