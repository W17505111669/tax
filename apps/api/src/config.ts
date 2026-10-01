import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./env.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(here, "..", "..", "..");

loadEnvFile(rootDir);

/**
 * 数据目录。默认是仓库里的 `data/`，可以用 `TAXAI_DATA_DIR` 重定向。
 *
 * 重定向不是为了部署灵活，是为了**测试隔离**：`verify:gates` 要用一个空数据目录把每个声称
 * 走真实数据的门禁跑一遍，确认它们在没数据时会红（否则空库就是空跑，一样绿）。此前 dataDir
 * 写死，那种检查只能对着真库做，等于没法做。
 */
export const dataDir = process.env.TAXAI_DATA_DIR
  ? path.resolve(process.env.TAXAI_DATA_DIR)
  : path.join(rootDir, "data");
export const dirs = {
  uploads: path.join(dataDir, "uploads"),
  outputs: path.join(dataDir, "outputs"),
  database: path.join(dataDir, "database"),
  demo: path.join(dataDir, "demo"),
};

for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

export const apiPort = Number(process.env.API_PORT ?? 8787);
export const apiHost = process.env.API_HOST ?? "127.0.0.1";
export const maxUploadBytes = 25 * 1024 * 1024;
export const allowedExtensions = [
  ".pdf",
  ".xlsx",
  ".xls",
  ".csv",
  ".docx",
  ".doc",
  ".txt",
  ".md",
  ".png",
  ".jpg",
  ".jpeg",
  ".ofd",
  ".xml",
  ".zip",
];
