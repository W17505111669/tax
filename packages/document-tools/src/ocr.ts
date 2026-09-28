import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker, type Worker } from "tesseract.js";

export interface OcrResult {
  text: string;
  confidence: number;
  provider: string;
}

/** OCR 适配器：默认 tesseract.js 本地引擎（chi_sim+eng），语言包缓存到项目 data/ocr-cache。 */
export const OCR_PROVIDER_NAME = "tesseract.js(chi_sim+eng)";

function defaultCacheDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // 语言包预置于 data/ocr-tessdata（tessdata_fast 4.1.0），避免运行时下载不稳定
  return path.resolve(here, "..", "..", "..", "data", "ocr-tessdata");
}

let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const cachePath = process.env.TAXAI_OCR_CACHE ?? defaultCacheDir();
      fs.mkdirSync(cachePath, { recursive: true });
      const worker = await createWorker(["chi_sim", "eng"], 1, { cachePath });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/** 识别图片中的文字（扫描件、发票照片等）。失败时抛错，由调用方降级提示。 */
export async function ocrImage(buffer: Uint8Array): Promise<OcrResult> {
  const worker = await getWorker();
  const { data } = await worker.recognize(Buffer.from(buffer));
  return {
    text: String(data.text ?? ""),
    confidence: Number(data.confidence ?? 0),
    provider: OCR_PROVIDER_NAME,
  };
}

/** 终止 OCR worker（脚本场景必须调用，否则子进程会保持事件循环不退出）。 */
export async function shutdownOcr(): Promise<void> {
  if (!workerPromise) return;
  const worker = await workerPromise;
  await worker.terminate();
  workerPromise = null;
}
