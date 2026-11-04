import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Ephemeral fixture-only build for the mounted human-UI QA. Never served in
// production; the QA script builds it into .tmp and serves it on loopback.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "../.tmp/human-mount-dist", emptyOutDir: true, rollupOptions: { input: "human-mount.html" } },
});
