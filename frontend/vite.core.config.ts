import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/static/",
  server: { proxy: { "/api": "http://127.0.0.1:18490", "/_gate": "http://127.0.0.1:18490", "/integrations": "http://127.0.0.1:18490" } },
  build: { outDir: "static/core", emptyOutDir: true, rollupOptions: { input: "core.html" } },
});
