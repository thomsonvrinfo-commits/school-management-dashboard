import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // "prompt": a new version waits until the app is next opened fresh, so an update can never
      // reload the page under a teacher who is halfway through a register.
      registerType: "prompt",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "SchoolPulse",
        short_name: "SchoolPulse",
        description: "School registers and results that keep working without internet.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#0a1128",
        theme_color: "#0a1128",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallback: "/index.html",
        // API calls are never answered from the cache: the app's own offline store handles those.
        navigateFallbackDenylist: [/^\/v1\//],
      },
    }),
  ],
  server: {
    port: 5173,
    // In development the API runs under `wrangler dev` on 8787.
    proxy: { "/v1": "http://localhost:8787" },
  },
});
