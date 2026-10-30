import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Development only: the daemon serves the built UI itself on 127.0.0.1:4545.
const backend = 'http://127.0.0.1:4546';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 4545,
    strictPort: true,
    proxy: {
      '/api': backend,
      '/ws': { target: backend, ws: true },
    },
  },
});
