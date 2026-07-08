import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发时把 /api/* 代理到本地 viewer 服务（默认 7777 端口）。
// Dev: proxy /api/* to the in-process viewer server.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:7777",
    },
  },
});
