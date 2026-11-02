import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:5080', '/hubs': { target: 'http://localhost:5080', ws: true } } },
  build: { outDir: 'dist', sourcemap: false, rollupOptions: { input: { main: './index.html', boardroom: './boardroom-template.html' } } }
});
