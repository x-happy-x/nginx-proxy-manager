import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // `npm run dev` proxies the API to a running manager: HOMENET_API, default local port 18490.
  const apiTarget =
    loadEnv(mode, ".", "HOMENET_").HOMENET_API || "http://127.0.0.1:18490";
  return {
    plugins: [react()],
    base: "/static/react/",
    server: {
      proxy: {
        "/api": apiTarget,
      },
    },
    build: {
      outDir: "./static/react",
      emptyOutDir: true,
    },
  };
});
