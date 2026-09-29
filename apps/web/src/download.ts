/**
 * 浏览器下载的公共实现。
 *
 * 之前 11 处各抄一遍「Blob → createObjectURL → a[download] → click → revokeObjectURL」，
 * charset、BOM、是否回收临时 URL 全靠抄的人记得，抄漏一次就是中文乱码或内存泄漏。
 * 收成一份后，调用方只给文件名与内容。
 *
 * 单独一个文件（而不是并入 csv.ts）是因为 apps/api 的 tsconfig 不带 DOM lib，
 * 验证脚本要直接 import csv.ts，把 document 关在这里，csv.ts 才能保持纯函数。
 */
import { CSV_BOM, csvBody, type CsvCell } from "./csv.ts";

/** 存一个已经构造好的 Blob（zip、JSON、SVG 一类）；参数顺序沿用既有调用方，避免改一堆调用点 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 下载文本文件：统一带 charset=utf-8；bom 为真时前置 BOM（CSV 给 Excel 用） */
export function downloadText(filename: string, text: string, mime: string, bom = false): void {
  downloadBlob(new Blob([bom ? CSV_BOM + text : text], { type: `${mime};charset=utf-8` }), filename);
}

/** 下载 CSV：BOM + CRLF + 引号转义 + 公式注入防护，口径全在 csv.ts */
export function downloadCsv(filename: string, rows: readonly (readonly CsvCell[])[]): void {
  downloadText(filename, csvBody(rows), "text/csv", true);
}
