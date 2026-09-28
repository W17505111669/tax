import ExcelJS from "exceljs";

export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: Array<Record<string, string | number | null>>;
  rowCount: number;
}

export interface ParsedDocument {
  fileName: string;
  fileType: string;
  ok: boolean;
  error?: string;
  sheets?: ParsedSheet[];
  pages?: number;
  textPreview?: string;
  ocrProvider?: string;
  ocrConfidence?: number;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const maybe = value as { text?: unknown; result?: unknown; formula?: unknown };
    if (maybe.result !== undefined) return cellText(maybe.result);
    if (maybe.text !== undefined) return cellText(maybe.text);
    return "";
  }
  return String(value);
}

/** 读取 Excel：自动识别表头行（首个含 ≥2 个非空文本的行），其余行转为记录。 */
export async function parseExcelFile(filePath: string, maxRows = 500): Promise<ParsedSheet[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheets: ParsedSheet[] = [];

  for (const ws of workbook.worksheets) {
    // getSheetValues 的行数组为 1-indexed，index 0 是幻影列，必须丢弃
    const matrix = (ws.getSheetValues() as unknown[][]).slice(1).map((row) => (row ?? []).slice(1).map(cellText));
    const nonEmpty = matrix.filter((row) => row.some((c) => c.trim() !== ""));
    if (nonEmpty.length === 0) continue;

    // 表头行需 ≥2 个非空且互不相同的单元格，避免合并标题行被误判为表头
    let headerIdx = nonEmpty.findIndex((row) => {
      const filled = row.filter((c) => c.trim() !== "");
      return filled.length >= 2 && new Set(filled).size >= 2;
    });
    if (headerIdx < 0) headerIdx = 0;
    const headers = nonEmpty[headerIdx]!.map((h, i) => (h.trim() !== "" ? h.trim() : `列${i + 1}`));
    const bodyRows = nonEmpty.slice(headerIdx + 1, headerIdx + 1 + maxRows);
    const rows = bodyRows.map((row) => {
      const record: Record<string, string | number | null> = {};
      headers.forEach((h, i) => {
        const raw = (row[i] ?? "").trim();
        if (raw === "") {
          record[h] = null;
          return;
        }
        const num = Number(raw.replace(/[,，\s]/g, ""));
        record[h] = Number.isFinite(num) && raw !== "" && /^-?[\d,\.]+$/.test(raw) ? num : raw;
      });
      return record;
    });
    sheets.push({ name: ws.name, headers, rows, rowCount: rows.length });
  }
  return sheets;
}

/** 极简 CSV 解析（支持双引号转义），复用 Excel 的表头识别逻辑。 */
export function parseCsvText(text: string, maxRows = 500): ParsedSheet[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const matrix = lines.map((line) => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else if (ch === '"') {
          quoted = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === "," || ch === ";" || ch === "\t") {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map((c) => c.trim());
  });
  if (matrix.length === 0) return [];
  let headerIdx = matrix.findIndex((row) => row.filter((c) => c !== "").length >= 2);
  if (headerIdx < 0) headerIdx = 0;
  const headers = matrix[headerIdx]!.map((h, i) => (h !== "" ? h : `列${i + 1}`));
  const rows = matrix.slice(headerIdx + 1, headerIdx + 1 + maxRows).map((row) => {
    const record: Record<string, string | number | null> = {};
    headers.forEach((h, i) => {
      const raw = row[i] ?? "";
      const num = Number(raw.replace(/[,，\s]/g, ""));
      record[h] = raw === "" ? null : Number.isFinite(num) && /^-?[\d,\.]+$/.test(raw) ? num : raw;
    });
    return record;
  });
  return [{ name: "csv", headers, rows, rowCount: rows.length }];
}
