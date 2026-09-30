import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: 'aoi-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const source = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
      const files = ['/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', ...Object.keys(bundle).filter(name => /\.(js|css)$/.test(name)).map(name => `/${name}`)];
      const hash = createHash('sha256').update(source + JSON.stringify(files));
      for (const file of ['./index.html', './public/manifest.webmanifest', './public/icon-192.png', './public/icon-512.png', './public/apple-touch-icon.png']) {
        hash.update(fs.readFileSync(new URL(file, import.meta.url)));
      }
      const version = hash.digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: source.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(files)) });
    },
  }],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/runtime-config.json': { target: 'http://localhost:3000' },
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
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
