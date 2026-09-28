/**
 * OCR 适配器验证：识别 data/demo/ocr-sample.png 中的中文与数字。
 * 首次运行会下载 chi_sim 语言包（约 20MB）并缓存到 data/ocr-cache。
 * 运行：pnpm verify:ocr
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ocrImage, shutdownOcr } from "../src/ocr.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = path.resolve(here, "..", "..", "..", "data", "demo", "ocr-sample.png");

if (!fs.existsSync(sample)) {
  console.error("[FAIL] 缺少样例图片:", sample);
  process.exit(1);
}

const buffer = new Uint8Array(fs.readFileSync(sample));
const result = await ocrImage(buffer);

console.log(`[verify] provider=${result.provider} confidence=${Math.round(result.confidence)}%`);
console.log(`[verify] text=${JSON.stringify(result.text.trim().slice(0, 120))}`);

const hasChinese = result.text.includes("辅助账") || result.text.includes("研发");
const hasNumber = result.text.includes("860000");
const pass = hasChinese && hasNumber && result.confidence > 40;
console.log(
  `[verify] chinese=${hasChinese} number860000=${hasNumber} confidenceOk=${result.confidence > 40}`,
);
console.log(pass ? "\n[PASS] OCR 适配器可识别中文与数字。" : "\n[FAIL] OCR 验证未通过。");
await shutdownOcr();
process.exitCode = pass ? 0 : 1;
