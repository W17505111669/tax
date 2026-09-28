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

/**
 * 判定某数据行是否被定位关键字命中，以及需要加深底色的列。支持三类关键字：
 * 1) 比对记录地址「记录名/列名」（如 `直接投入/金额（元）`）→ 命中记录所在行 + 对应列；
 * 2) A1 单元格地址，可带「工作表!」前缀（如 `归集比对!B3`）→ 命中对应行列，仅在该表未排序时可靠；
 * 3) 普通文本 → 全等优先，其次包含匹配。
 * rowIndex 为数据行下标（0 基，表头不计入）。
 */
export function sheetLocate(
  row: LocateRow,
  headers: string[],
  rowIndex: number,
  q: string,
  sheetName: string,
  sorted: boolean,
): LocateResult {
  const needle = q.trim();
  if (!needle) return { hit: false, cols: [] };

  const a1 = A1_RE.exec(needle);
  const colLetters = a1?.[2];
  const rowPart = a1?.[3];
  if (a1 && colLetters && rowPart && !sorted) {
    const sheetPart = a1[1];
    if (sheetPart && sheetPart !== sheetName) return { hit: false, cols: [] };
    const colName = headers[colLettersToIndex(colLetters)];
    if (colName !== undefined && Number(rowPart) - 2 === rowIndex) {
      return { hit: true, cols: [colName] };
    }
    return { hit: false, cols: [] };
  }

  const lower = needle.toLowerCase();
  const slash = needle.lastIndexOf("/");
  const recKey = slash > 0 ? needle.slice(0, slash).trim().toLowerCase() : "";
  const colKey = slash > 0 ? needle.slice(slash + 1).trim().toLowerCase() : "";
  const cols: string[] = [];
  if (colKey) {
    for (const h of headers) {
      const hl = h.toLowerCase();
      if (hl === colKey || hl.includes(colKey) || colKey.includes(hl)) cols.push(h);
    }
  }
  let hit = false;
  for (const h of headers) {
    const v = row[h];
    if (v === null || v === undefined) continue;
    const text = String(v).trim().toLowerCase();
    if (!text) continue;
    if (recKey) {
      if (text === recKey || (recKey.length >= 2 && text.includes(recKey))) hit = true;
    } else if (text === lower || text.includes(lower)) {
      hit = true;
      if (!cols.includes(h)) cols.push(h);
    }
  }
  if (recKey && !hit) return { hit: false, cols: [] };
  return { hit, cols };
}
