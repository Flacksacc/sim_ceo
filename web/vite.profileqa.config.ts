import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Isolated QA config: serves the app on :5168 proxied to the disposable QA
// API on :5208, so browser QA never touches the developer :5173/:5080 pair.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5168,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:5208",
      "/hubs": { target: "http://127.0.0.1:5208", ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
