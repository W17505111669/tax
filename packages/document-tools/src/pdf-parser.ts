import { extractText } from "unpdf";

/** 提取 PDF 文本（扫描件无文本层时返回空，调用方应提示需要 OCR）。 */
export async function parsePdfFile(filePath: string): Promise<{ pages: number; text: string }> {
  const buffer = new Uint8Array(await (await import("node:fs/promises")).readFile(filePath));
  const result = await extractText(buffer, { mergePages: false });
  const pages = Array.isArray(result.text) ? result.text : [String(result.text ?? "")];
  return { pages: pages.length, text: pages.join("\n") };
}
