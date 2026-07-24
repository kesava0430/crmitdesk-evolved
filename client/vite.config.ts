import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Regex key so this only matches paths starting with "/api/". A plain
      // string key ('/api') matches by prefix, which also swallows the
      // "/api-keys" client route (it starts with "/api" too) — every
      // navigation to that page was being proxied to Express instead of
      // served by the SPA, 404ing with "Cannot GET /api-keys".
      '^/api/.*': { target: 'http://127.0.0.1:4000', changeOrigin: true },
    },
  },
});
