import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Isolated QA config: serves the app on :5174 proxied to the disposable QA
// API on :5099, so browser QA never touches the developer :5173/:5080 pair.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:5099",
      "/hubs": { target: "http://127.0.0.1:5099", ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
