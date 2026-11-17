import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Development only: the installed daemon serves the built UI itself on 127.0.0.1:4545, so `pnpm dev` keeps to
// 4555 and 4556 and both run at once.
const backend = 'http://127.0.0.1:4556';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        // Libraries change less often than the app, so each keeps its own file and the browser keeps it cached across
        // updates. xterm stays out: only the pages with a terminal load it.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'router', test: /node_modules[\\/](react-router|react-router-dom)[\\/]/, priority: 20 },
            { name: 'query', test: /node_modules[\\/]@tanstack[\\/]/, priority: 20 },
            { name: 'zod', test: /node_modules[\\/]zod[\\/]/, priority: 20 },
          ],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4555,
    strictPort: true,
    proxy: {
      '/api': backend,
      '/ws': { target: backend, ws: true },
      '/terminals': { target: backend, ws: true },
      '/browser': { target: backend, ws: true },
      '/processes': { target: backend, ws: true },
    },
  },
});
