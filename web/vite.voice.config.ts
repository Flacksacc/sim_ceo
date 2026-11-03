import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5192,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:5115",
      "/hubs": { target: "http://127.0.0.1:5115", ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});