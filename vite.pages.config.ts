import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const base = "/DADE-vip/";

export default defineConfig({
  root,
  base,
  plugins: [react()],
  resolve: { alias: {
    "@": fileURLToPath(new URL("./src", import.meta.url)),
    "next/navigation": fileURLToPath(new URL("./src/demo/navigation.ts", import.meta.url)),
    "next/link": fileURLToPath(new URL("./src/demo/link.tsx", import.meta.url)),
    "next/image": fileURLToPath(new URL("./src/demo/image.tsx", import.meta.url)),
  } },
  define: {
    "process.env.NEXT_PUBLIC_STATIC_DEMO": JSON.stringify("true"),
    "process.env.NEXT_PUBLIC_SITE_BASE": JSON.stringify(base.slice(0, -1)),
  },
  build: { outDir: "dist-pages", emptyOutDir: true, rollupOptions: { input: "web-entry/index.html" } },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
