import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Integration-checkpoint isolated config: serves the app on :5193 proxied to
// the disposable integration API on :5121. Never touches :5173/:5080.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5193,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:5121",
      "/hubs": { target: "http://127.0.0.1:5121", ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
