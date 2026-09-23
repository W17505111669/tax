import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./env.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(here, "..", "..", "..");

loadEnvFile(rootDir);

export const dataDir = path.join(rootDir, "data");
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
