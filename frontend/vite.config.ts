import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Development only: the installed daemon serves the built UI itself on 127.0.0.1:4545, so `pnpm dev` keeps to
// 4555 and 4556 and both run at once.
const backend = 'http://127.0.0.1:4556';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 4555,
    strictPort: true,
    proxy: {
      '/api': backend,
      '/ws': { target: backend, ws: true },
      '/terminals': { target: backend, ws: true },
    },
  },
});
