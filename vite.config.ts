import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// On GitHub Pages a project site is served from /<repo>/. The deploy workflow
// passes the repo name via VITE_BASE so this works no matter what the repo is
// called; local dev and user/org pages fall back to "/".
const base = process.env.VITE_BASE ?? "/";

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
