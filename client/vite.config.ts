import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Switched from the default "generateSW" strategy to "injectManifest"
      // so we can ship a custom service worker (src/sw.ts) with a 'push'
      // event handler for real browser/OS push notifications — generateSW
      // only supports Workbox's declarative runtime-caching config, not
      // arbitrary event listeners. src/sw.ts reimplements the same
      // NetworkOnly /api/ + /portal/ caching rule this used to declare here.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'logo.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'CRMITdesk Evolved',
        short_name: 'CRMITdesk',
        description: 'CRM and IT Help Desk platform',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        // Keeps the precache manifest from ballooning with every hashed JS
        // chunk; the app is a JS-heavy SPA where that trade-off (smaller
        // install footprint vs. offline coverage) matches the previous
        // generateSW config's default behavior closely enough.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
        type: 'module',
      },
    }),
  ],
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
