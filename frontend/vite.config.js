import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'OmniCloud',
        short_name: 'OmniCloud',
        description: 'Unified home for all your clouds',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f8fafd',
        theme_color: '#f8fafd',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        // O service worker só serve o app shell; a API e o WebSocket de upload
        // precisam ir sempre à rede.
        navigateFallbackDenylist: [/^\/api/, /^\/ws/],
      },
    }),
  ],
});
