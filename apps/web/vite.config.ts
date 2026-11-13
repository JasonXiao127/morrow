import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const apiProxyTarget = process.env["VITE_API_PROXY"] ?? "http://localhost:3100";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: false,
      registerType: "prompt",
      // The manifest is served from public/manifest.webmanifest so it can be
      // reviewed without generating icons at build time.
      manifest: false,
      injectManifest: {
        globPatterns: [
          "**/*.{js,css,html,svg,png,woff,woff2,webmanifest}",
        ],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: false,
      },
      "/events": {
        target: apiProxyTarget,
        changeOrigin: false,
      },
      "/healthz": {
        target: apiProxyTarget,
        changeOrigin: false,
      },
      "/readyz": {
        target: apiProxyTarget,
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: true,
    port: 4173,
  },
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          router: [
            "@tanstack/react-router",
            "@tanstack/react-query",
            "@tanstack/react-query-persist-client",
          ],
          markdown: ["react-markdown", "remark-gfm", "rehype-sanitize"],
          ui: [
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-tooltip",
            "@radix-ui/react-switch",
            "@radix-ui/react-visually-hidden",
            "cmdk",
            "sonner",
            "lucide-react",
          ],
        },
      },
    },
  },
});
