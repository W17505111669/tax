import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// defineConfig 求值时 Vite 还没加载 .env，端口要自己读：apps/web/.env 覆盖仓库根 .env
// （.env.example 在根目录），真实环境变量优先级最高。本机 5173 常被别的项目占用，
// 固定 WEB_PORT 才能保证浏览器地址、深链与文档里的端口三者一致。
const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.env.NODE_ENV ?? "development";
const fileEnv = {
  ...loadEnv(mode, path.resolve(here, "../.."), ""),
  ...loadEnv(mode, here, ""),
};
const pick = (key: string, fallback: string): string => process.env[key] ?? fileEnv[key] ?? fallback;

const apiPort = pick("API_PORT", "8787");
const webPort = Number(pick("WEB_PORT", "5173"));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: webPort,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
