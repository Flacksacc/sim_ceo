// Isolated source-governance QA Vite config. Binds STRICTLY to 127.0.0.1:5184
// and proxies ONLY to the owned QA API on 127.0.0.1:5095. Never use the
// default vite.config.ts for mutating QA: it proxies to :5080 (real user data).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5184,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:5095',
      '/hubs': { target: 'http://127.0.0.1:5095', ws: true },
    },
  },
  build: { outDir: '../.tmp/sourceqa-dist', sourcemap: false },
});