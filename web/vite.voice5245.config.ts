import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Muse-owned QA namespace: web 5245 -> API 5125. Legacy voice ports
// (5192/5115) are not reused.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5245,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:5125",
      "/hubs": { target: "http://127.0.0.1:5125", ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});