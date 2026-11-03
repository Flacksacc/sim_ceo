import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { port: 5187, strictPort: true, host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:5097", "/hubs": { target: "http://127.0.0.1:5097", ws: true } } },
  build: { outDir: "dist", sourcemap: false },
});
