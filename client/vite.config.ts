import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/runtime-config.json': { target: 'http://localhost:3000' },
      '/api': {
        target: 'http://localhost:3000',
        // Preserve the browser origin for the login routes' same-origin check.
        changeOrigin: false,
      },
      '/files': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
});
