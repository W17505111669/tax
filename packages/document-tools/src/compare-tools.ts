import path from "node:path";
import ExcelJS from "exceljs";
import { Type } from "typebox";
import type { ToolDefinition } from "@tax/agent-core";
import { yuanToCents } from "@tax/shared-schemas";
import type { TaskDocumentContext } from "./task-tools.ts";

export interface CellDiff {
  address: string;
  a: string | number | null;
  b: string | number | null;
  kind: "mismatch" | "only_a" | "only_b";
}

export interface SheetCompare {
  sheetA: string;
  sheetB: string;
  mode: "record" | "address";
  compared: number;
  matched: number;
  mismatched: number;
  onlyA: number;
  onlyB: number;
  skippedFormulas: number;
  accuracyPercent: number;
  diffs: CellDiff[];
}

export interface CompareResult {
  sheets: SheetCompare[];
  unmatchedSheetsA: string[];
  unmatchedSheetsB: string[];
  a?: { kind: "upload" | "artifact"; name: string };
  b?: { kind: "upload" | "artifact"; name: string };
  totals: {
    compared: number;
    matched: number;
    mismatched: number;
    onlyA: number;
    onlyB: number;
    accuracyPercent: number;
  };
}

function isFormulaValue(value: unknown): value is { formula: string; result?: unknown } {
  return typeof value === "object" && value !== null && typeof (value as { formula?: unknown }).formula === "string";
}

function displayValue(cell: ExcelJS.Cell): { v: string | number | null; skippedFormula: boolean } {
  const val = cell.value;
  if (val === null || val === undefined) return { v: null, skippedFormula: false };
  if (isFormulaValue(val)) {
    const res = val.result;
    if (typeof res === "number") return { v: res, skippedFormula: false };
    if (typeof res === "string" && res.trim() !== "") return { v: res.trim(), skippedFormula: false };
    return { v: null, skippedFormula: true };
  }
  if (typeof val === "number") return { v: val, skippedFormula: false };
  if (typeof val === "string") {
    const t = val.trim();
    return { v: t === "" ? null : t, skippedFormula: false };
  }
  if (val instanceof Date) return { v: val.toISOString().slice(0, 10), skippedFormula: false };
  const rich = val as { text?: unknown };
  if (typeof rich.text === "string" && rich.text.trim() !== "") return { v: rich.text.trim(), skippedFormula: false };
  return { v: null, skippedFormula: false };
}

function toCents(v: string | number): number | null {
  if (typeof v === "number") return Math.round(v * 100);
  try {
    return yuanToCents(v);
  } catch {
    return null;
  }
}

function sameValue(a: string | number, b: string | number, toleranceCents: number): boolean {
  const ca = toCents(a);
  const cb = toCents(b);
  if (ca !== null && cb !== null) return Math.abs(ca - cb) <= toleranceCents;
  return String(a).trim() === String(b).trim();
}

interface SheetRecords {
  keyColumn: string;
  columns: string[];
  rows: Map<string, Map<string, string | number>>;
  skipped: number;
}

/** 记录级读取：探测表头行（≥2 个互不相同非空文本），以首列为主键组织记录。 */
function readRecords(ws: ExcelJS.Worksheet): SheetRecords | null {
  const matrix: Array<Map<number, string | number>> = [];
  let skipped = 0;
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = new Map<number, string | number>();
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const { v, skippedFormula } = displayValue(cell);
      if (skippedFormula) {
        skipped += 1;
        return;
      }
      if (v !== null) cells.set(colNumber, v);
    });
    if (cells.size > 0) matrix.push(cells);
  });

  const headerIdx = matrix.findIndex((cells) => {
    const texts = [...cells.values()].filter((v): v is string => typeof v === "string");
    return texts.length >= 2 && new Set(texts).size >= 2;
  });
  if (headerIdx < 0) return null;

  const headerCells = matrix[headerIdx]!;
  const cols = [...headerCells.entries()].sort((x, y) => x[0] - y[0]);
  const columns = cols.map(([, v]) => String(v));
  const colIndexOf = new Map(cols.map(([idx, v], pos) => [String(v), { idx, pos }]));
  const keyEntry = cols[0];
  if (!keyEntry) return null;
  const keyColumn = String(keyEntry[1]);

  const rows = new Map<string, Map<string, string | number>>();
  for (const cells of matrix.slice(headerIdx + 1)) {
    const keyValue = cells.get(keyEntry[0]);
    if (keyValue === undefined) continue;
    const key = String(keyValue).trim();
    if (key === "") continue;
    const record = new Map<string, string | number>();
    for (const [name, info] of colIndexOf) {
      if (info.pos === 0) continue;
      const v = cells.get(info.idx);
      if (v !== undefined) record.set(name, v);
    }
    rows.set(key, record);
  }
  return { keyColumn, columns, rows, skipped };
}

function compareRecords(a: SheetRecords, b: SheetRecords, toleranceCents: number, maxDiffs: number): Omit<SheetCompare, "sheetA" | "sheetB" | "mode"> {
  const commonCols = a.columns.filter((c) => c !== a.keyColumn && b.columns.includes(c));
  const diffs: CellDiff[] = [];
  let matched = 0;
  let mismatched = 0;
  let onlyA = 0;
  let onlyB = 0;

  for (const [key, recA] of a.rows) {
    const recB = b.rows.get(key);
    if (!recB) {
      onlyA += recA.size + 1;
      if (diffs.length < maxDiffs) diffs.push({ address: `${key}(整行)`, a: "存在", b: null, kind: "only_a" });
      continue;
    }
    for (const col of commonCols) {
      const va = recA.get(col);
      const vb = recB.get(col);
      if (va === undefined && vb === undefined) continue;
      if (va === undefined) {
        onlyB += 1;
        if (diffs.length < maxDiffs) diffs.push({ address: `${key}/${col}`, a: null, b: vb ?? null, kind: "only_b" });
        continue;
      }
      if (vb === undefined) {
        onlyA += 1;
        if (diffs.length < maxDiffs) diffs.push({ address: `${key}/${col}`, a: va, b: null, kind: "only_a" });
        continue;
      }
      if (sameValue(va, vb, toleranceCents)) matched += 1;
      else {
        mismatched += 1;
        if (diffs.length < maxDiffs) diffs.push({ address: `${key}/${col}`, a: va, b: vb, kind: "mismatch" });
      }
    }
  }
  for (const [key, recB] of b.rows) {
    if (!a.rows.has(key)) {
      onlyB += recB.size + 1;
      if (diffs.length < maxDiffs) diffs.push({ address: `${key}(整行)`, a: null, b: "存在", kind: "only_b" });
    }
  }

  const compared = matched + mismatched + onlyA + onlyB;
  return {
    compared,
    matched,
    mismatched,
    onlyA,
    onlyB,
    skippedFormulas: a.skipped + b.skipped,
    accuracyPercent: compared === 0 ? 100 : Math.round((matched / compared) * 10000) / 100,
    diffs,
  };
}

function compareAddress(
  wsA: ExcelJS.Worksheet,
  wsB: ExcelJS.Worksheet,
  toleranceCents: number,
  maxDiffs: number,
): Omit<SheetCompare, "sheetA" | "sheetB" | "mode"> {
  const read = (ws: ExcelJS.Worksheet) => {
    const map = new Map<string, string | number>();
    let skipped = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const { v, skippedFormula } = displayValue(cell);
        if (skippedFormula) {
          skipped += 1;
          return;
        }
        if (v !== null) map.set(cell.address, v);
      });
    });
    return { map, skipped };
  };
  const a = read(wsA);
  const b = read(wsB);
  const diffs: CellDiff[] = [];
  let matched = 0;
  let mismatched = 0;
  let onlyA = 0;
  let onlyB = 0;
  for (const [addr, va] of a.map) {
    if (b.map.has(addr)) {
      const vb = b.map.get(addr)!;
      if (sameValue(va, vb, toleranceCents)) matched += 1;
      else {
        mismatched += 1;
        if (diffs.length < maxDiffs) diffs.push({ address: addr, a: va, b: vb, kind: "mismatch" });
      }
    } else {
      onlyA += 1;
      if (diffs.length < maxDiffs) diffs.push({ address: addr, a: va, b: null, kind: "only_a" });
    }
  }
  for (const [addr, vb] of b.map) {
    if (!a.map.has(addr)) {
      onlyB += 1;
      if (diffs.length < maxDiffs) diffs.push({ address: addr, a: null, b: vb, kind: "only_b" });
    }
  }
  const compared = matched + mismatched + onlyA + onlyB;
  return {
    compared,
    matched,
    mismatched,
    onlyA,
    onlyB,
    skippedFormulas: a.skipped + b.skipped,
    accuracyPercent: compared === 0 ? 100 : Math.round((matched / compared) * 10000) / 100,
    diffs,
  };
}

/** 逐格/逐记录比对两份 Excel 底稿，输出一致、差异、单方缺失与准确率。 */
export async function compareWorkbooks(
  pathA: string,
  pathB: string,
  opts: { toleranceCents?: number; sheetPairs?: Array<[string, string]>; maxDiffs?: number; align?: "record" | "address" } = {},
): Promise<CompareResult> {
  const toleranceCents = opts.toleranceCents ?? 0;
  const maxDiffs = opts.maxDiffs ?? 60;
  const align = opts.align ?? "record";
  const wbA = new ExcelJS.Workbook();
  await wbA.xlsx.readFile(pathA);
  const wbB = new ExcelJS.Workbook();
  await wbB.xlsx.readFile(pathB);

  const namesA = wbA.worksheets.map((w) => w.name);
  const namesB = wbB.worksheets.map((w) => w.name);
  const pairs: Array<[string, string]> =
    opts.sheetPairs && opts.sheetPairs.length > 0
      ? opts.sheetPairs
      : namesA.filter((n) => namesB.includes(n)).map((n) => [n, n]);
  const pairedA = new Set(pairs.map((p) => p[0]));
  const pairedB = new Set(pairs.map((p) => p[1]));

  const sheets: SheetCompare[] = [];
  for (const [na, nb] of pairs) {
    const wsA = wbA.getWorksheet(na);
    const wsB = wbB.getWorksheet(nb);
    if (!wsA || !wsB) continue;

    let body: Omit<SheetCompare, "sheetA" | "sheetB" | "mode">;
    let mode: "record" | "address" = align;
    if (align === "record") {
      const ra = readRecords(wsA);
      const rb = readRecords(wsB);
      if (ra && rb) {
        body = compareRecords(ra, rb, toleranceCents, maxDiffs);
      } else {
        mode = "address";
        body = compareAddress(wsA, wsB, toleranceCents, maxDiffs);
      }
    } else {
      body = compareAddress(wsA, wsB, toleranceCents, maxDiffs);
    }
    sheets.push({ sheetA: na, sheetB: nb, mode, ...body });
  }

  const totals = sheets.reduce(
    (acc, s) => ({
      compared: acc.compared + s.compared,
      matched: acc.matched + s.matched,
      mismatched: acc.mismatched + s.mismatched,
      onlyA: acc.onlyA + s.onlyA,
      onlyB: acc.onlyB + s.onlyB,
      accuracyPercent: 0,
    }),
    { compared: 0, matched: 0, mismatched: 0, onlyA: 0, onlyB: 0, accuracyPercent: 0 },
  );
  totals.accuracyPercent =
    totals.compared === 0 ? 100 : Math.round((totals.matched / totals.compared) * 10000) / 100;

  return {
    sheets,
    unmatchedSheetsA: namesA.filter((n) => !pairedA.has(n)),
    unmatchedSheetsB: namesB.filter((n) => !pairedB.has(n)),
    totals,
  };
}

/** 底稿比对工具：系统产物 vs 人工参考底稿，输出逐格差异与准确率。 */
export function createCompareTools(ctx: TaskDocumentContext): ToolDefinition[] {
  const resolvePath = (ref: { kind: "upload" | "artifact"; name: string }): string => {
    if (ref.kind === "upload") {
      const file = ctx.files.find((f) => f.fileName === ref.name);
      if (!file) throw new Error(`上传资料中找不到文件: ${ref.name}`);
      return file.storagePath;
    }
    return path.join(ctx.outputsDir, path.basename(ref.name));
  };

  const compareTool: ToolDefinition = {
    name: "compare_workpapers",
    label: "底稿逐格比对",
    description:
      "比对两份 Excel 底稿（系统生成产物与人工完成参考底稿）。默认记录级比对：按表头行与主键列对齐记录，跨版式仍可比；align=address 时按单元格地址比对（限同版式）。输出一致格数、数值差异、单方缺失与准确率。差异只报告不自动修改。",
    promptSnippet: "compare_workpapers: 系统底稿 vs 人工底稿比对与准确率",
    parameters: Type.Object({
      a: Type.Object({
        kind: Type.Union([Type.Literal("upload"), Type.Literal("artifact")]),
        name: Type.String(),
      }),
      b: Type.Object({
        kind: Type.Union([Type.Literal("upload"), Type.Literal("artifact")]),
        name: Type.String(),
      }),
      toleranceYuan: Type.Optional(Type.String({ description: "数值容差（元），默认 0.00" })),
      align: Type.Optional(Type.Union([Type.Literal("record"), Type.Literal("address")])),
    }),
    async execute(_id, params: {
      a: { kind: "upload" | "artifact"; name: string };
      b: { kind: "upload" | "artifact"; name: string };
      toleranceYuan?: string;
      align?: "record" | "address";
    }) {
      const toleranceCents = params.toleranceYuan ? yuanToCents(params.toleranceYuan) : 0;
      const result = await compareWorkbooks(resolvePath(params.a), resolvePath(params.b), {
        toleranceCents,
        align: params.align,
      });
      const lines = [
        `底稿比对结果（${result.sheets[0]?.mode ?? "record"} 模式）：总准确率 ${result.totals.accuracyPercent}%（比对 ${result.totals.compared} 项：一致 ${result.totals.matched}、差异 ${result.totals.mismatched}、仅A ${result.totals.onlyA}、仅B ${result.totals.onlyB}）`,
        ...result.sheets.map(
          (s) =>
            `- 工作表「${s.sheetA}」：准确率 ${s.accuracyPercent}%（一致 ${s.matched}/比对 ${s.compared}；差异 ${s.mismatched}；仅A ${s.onlyA}；仅B ${s.onlyB}）`,
        ),
        ...result.sheets.flatMap((s) =>
          s.diffs.slice(0, 20).map((d) => `    ${d.kind === "mismatch" ? "差异" : d.kind === "only_a" ? "仅A" : "仅B"} ${d.address}：A=${d.a ?? "∅"} B=${d.b ?? "∅"}`),
        ),
      ];
      if (result.unmatchedSheetsA.length || result.unmatchedSheetsB.length) {
        lines.push(
          `未配对工作表：A=${result.unmatchedSheetsA.join(",") || "无"}；B=${result.unmatchedSheetsB.join(",") || "无"}`,
        );
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ...result, a: params.a, b: params.b },
      };
    },
  };

  return [compareTool];
}
