/**
 * CSV 导出的统一口径（纯函数 + 一个浏览器下载助手）。
 *
 * 之前台账、底稿比对差异、任务清单各写了一份转义，三份还不一样：有的漏了 \r，
 * 都没有防公式注入。交付件里同时存在两种口径既难维护也不安全，这里收成一份，
 * 组件只负责给出二维数据与文件名。
 *
 * 防公式注入：任务标题、底稿单元格来自用户输入或客户上传的文件，若以 = + - @
 * 或制表符开头，Excel/WPS 打开时会当公式执行（`=cmd|' /C calc'!A0` 一类），
 * 交付件里不能留这种口子。做法是给这类值前置一个单引号，Excel 视为文本；
 * 纯数字不加前缀，否则合计与计数会被当文本、拿到表里没法再求和。
 */

/** Excel 打开中文 CSV 需要 BOM，下载时前置 */
export const CSV_BOM = "\uFEFF";

/** RFC 4180 用 CRLF：Excel 与记事本对纯 LF 的分行处理并不一致 */
export const CSV_EOL = "\r\n";

export type CsvCell = string | number | null | undefined;

/** 会被 Excel 当公式起头的字符；负号后面直接跟数字的属于数值，不算 */
const FORMULA_HEAD = /^[=+@\t\r]|^-(?!\d)/;
const NUMERIC = /^[+-]?\d+(?:\.\d+)?$/;

/** 单元格转义：需要时加引号并把引号翻倍，公式起头前置单引号 */
export function csvField(value: CsvCell): string {
  const s = value === null || value === undefined ? "" : String(value);
  const guarded = FORMULA_HEAD.test(s) && !NUMERIC.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** 一行：逐格转义后用逗号连接 */
export function csvRow(cells: readonly CsvCell[]): string {
  return cells.map(csvField).join(",");
}

/** 二维数据 → CSV 文本（不含 BOM，下载时前置） */
export function csvBody(rows: readonly (readonly CsvCell[])[]): string {
  return rows.map(csvRow).join(CSV_EOL);
}
