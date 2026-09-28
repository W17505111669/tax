/**
 * 表格定位纯函数：比对页点击差异行 → 阅读器表格高亮。
 * 从 SideReader 抽出，便于 apps/api/scripts/verify-sheet-locate.ts 直接校验（不依赖 React/DOM）。
 */

export type LocateRow = Record<string, string | number | null>;

export type LocateResult = { hit: boolean; cols: string[] };

/** A1 列标转 0 基列序："A"->0，"B"->1，"AA"->26 */
export function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const A1_RE = /^(?:([^!]+)!)?\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

function cellText(v: string | number | null | undefined): string {
  return v === null || v === undefined ? "" : String(v).trim();
}

/** 值等价判定：忽略大小写全等，或去千分位/空格后数值相等（420000 与 "420,000.00" 视为同值） */
export function sameValue(cell: string, expect: string): boolean {
  const a = cell.trim();
  const b = expect.trim();
  if (!a || !b) return false;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const na = Number(a.replace(/[,，\s]/g, ""));
  const nb = Number(b.replace(/[,，\s]/g, ""));
  return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 1e-9;
}

/**
 * 判定某数据行是否被定位关键字命中，以及需要加深底色的列。q 支持三类：
 * 1) 比对记录地址「记录名/列名」（如 `直接投入/金额（元）`）→ 命中记录所在行 + 对应列；
 * 2) A1 单元格地址，可带「工作表!」前缀（如 `归集比对!B3`）→ 命中对应行列，仅在该表未排序时可靠；
 * 3) 普通文本 → 全等优先，其次包含匹配。
 * expect 传比对侧的期望值（差异行的 A/B 值）：给出后必须通过值校验才算命中，
 * 以防解析器跳行时 A1 几何定位落到错误行；此时命中的列会收窄到真正持有该值的列。
 * rowIndex 为数据行下标（0 基，表头不计入）。
 */
export function sheetLocate(
  row: LocateRow,
  headers: string[],
  rowIndex: number,
  q: string,
  sheetName: string,
  sorted: boolean,
  expect?: string | number | null,
): LocateResult {
  const needle = q.trim();
  const exp = cellText(expect);
  if (!needle && !exp) return { hit: false, cols: [] };

  // A) A1 几何定位（该表未排序时才能按行号推算）
  const a1 = needle ? A1_RE.exec(needle) : null;
  const colLetters = a1?.[2];
  const rowPart = a1?.[3];
  if (a1 && colLetters && rowPart && !sorted) {
    const sheetPart = a1[1];
    if (sheetPart && sheetPart !== sheetName) return { hit: false, cols: [] };
    const colName = headers[colLettersToIndex(colLetters)];
    if (colName === undefined || Number(rowPart) - 2 !== rowIndex) return { hit: false, cols: [] };
    if (!exp || sameValue(cellText(row[colName]), exp)) return { hit: true, cols: [colName] };
    return { hit: false, cols: [] };
  }

  // B) 记录地址「记录名/列名」或普通文本
  const lower = needle.toLowerCase();
  const slash = needle.lastIndexOf("/");
  const recKey = slash > 0 ? needle.slice(0, slash).trim().toLowerCase() : "";
  const colKey = slash > 0 ? needle.slice(slash + 1).trim().toLowerCase() : "";
  const keyCols: string[] = [];
  if (colKey) {
    for (const h of headers) {
      const hl = h.toLowerCase();
      if (hl === colKey || hl.includes(colKey) || colKey.includes(hl)) keyCols.push(h);
    }
  }
  let hit = false;
  const textCols: string[] = [];
  for (const h of headers) {
    const text = cellText(row[h]);
    if (!text) continue;
    const t = text.toLowerCase();
    if (recKey) {
      if (t === recKey || (recKey.length >= 2 && t.includes(recKey))) hit = true;
    } else if (needle && (t === lower || t.includes(lower))) {
      hit = true;
      if (!textCols.includes(h)) textCols.push(h);
    }
  }
  if (recKey && !hit) return { hit: false, cols: [] };

  // C) 期望值校验 / 纯值定位
  if (exp) {
    const valCols = headers.filter((h) => sameValue(cellText(row[h]), exp));
    if (valCols.length === 0) return { hit: false, cols: [] };
    if (!needle) return { hit: true, cols: valCols };
    if (!hit) return { hit: false, cols: [] };
    const narrowed = keyCols.filter((h) => valCols.includes(h));
    return { hit: true, cols: narrowed.length > 0 ? narrowed : valCols };
  }

  return recKey ? { hit, cols: keyCols } : { hit, cols: textCols };
}

export type SortSpec = { col: string; dir: 1 | -1 };

/** 渲染取行上限：主栏与副栏一致，超出部分提示回主表操作 */
export const SHEET_ROW_LIMIT = 100;

/** 排序：两侧都能解析成数值时按数值比较，否则按 zh-CN 本地化比较；无排序状态时原样返回 */
export function sortRows(rows: LocateRow[], spec?: SortSpec | null): LocateRow[] {
  if (!spec) return rows;
  return [...rows].sort((a, b) => {
    const av = a[spec.col];
    const bv = b[spec.col];
    const an = typeof av === "number" ? av : parseFloat(String(av ?? ""));
    const bn = typeof bv === "number" ? bv : parseFloat(String(bv ?? ""));
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return (an - bn) * spec.dir;
    return String(av ?? "").localeCompare(String(bv ?? ""), "zh-CN") * spec.dir;
  });
}

/** 主栏与副栏共用的取行口径：前 SHEET_ROW_LIMIT 行 + 排序 */
export function visibleRows(rows: LocateRow[], spec?: SortSpec | null): LocateRow[] {
  return sortRows(rows.slice(0, SHEET_ROW_LIMIT), spec);
}

/**
 * 一张工作表的定位结果：渲染行、逐行命中与命中数。
 * 主栏渲染、副栏渲染与「命中总数 / 上下跳转」都走这里，避免三处口径漂移。
 */
export function locateSheet(
  sheet: { name: string; headers: string[]; rows: LocateRow[] },
  spec: SortSpec | null | undefined,
  q: string,
  expect?: string | number | null,
): { rows: LocateRow[]; hits: LocateResult[]; count: number } {
  const rows = visibleRows(sheet.rows, spec);
  const needle = q.trim();
  const hits = needle
    ? rows.map((row, i) => sheetLocate(row, sheet.headers, i, needle, sheet.name, Boolean(spec), expect))
    : [];
  return { rows, hits, count: hits.filter((h) => h.hit).length };
}
