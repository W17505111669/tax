/**
 * CSV 下载的浏览器部分。
 *
 * 单独一个文件是因为 apps/api 的 tsconfig 不带 DOM lib，而验证脚本会 import csv.ts；
 * 把 document 关在这里，csv.ts 就能保持纯函数、被 api 侧直接引用与验证。
 */
import { CSV_BOM, csvBody, type CsvCell } from "./csv.ts";

/** 浏览器下载 CSV：BOM + CRLF，Excel 双击打开中文不乱码 */
export function downloadCsv(filename: string, rows: readonly (readonly CsvCell[])[]): void {
  const blob = new Blob([CSV_BOM + csvBody(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
