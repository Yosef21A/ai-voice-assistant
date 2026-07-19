// Vite build for the Omen Clinic Concierge dashboard SPA.
//
// The whole web app lives under web/ (this file's directory). `root` is pinned to
// that directory so `vite build` bundles web/index.html + web/src/** into web/dist,
// which src/server.js then serves statically at / with an SPA fallback. React and
// Vite are devDependencies only — the bundle is plain static files, so the runtime
// server keeps its express + pg dependency footprint.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: import.meta.dirname,
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Lean single-vendor split keeps the transferred bytes small and cacheable.
    // Vite 8's bundler (rolldown) wants manualChunks as a function, not a map.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/node_modules[/\\](react|react-dom|scheduler)[/\\]/.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    // `npm run web:dev` runs the SPA on 5173 and proxies the API/webhook to the
    // Express server on 3000 so cookies + SSE work same-origin during development.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/webhook': { target: 'http://localhost:3000', changeOrigin: true },
      '/simulate': { target: 'http://localhost:3000', changeOrigin: true },
      '/health': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
