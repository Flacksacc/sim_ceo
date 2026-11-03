import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Isolated Phase7 QA: strict port 5189 proxies API to memory API :5111.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5189,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:5111",
      "/hubs": { target: "http://127.0.0.1:5111", ws: true },
    },
  },
  build: { outDir: "../.tmp/wikiqa-dist", sourcemap: false },
});
