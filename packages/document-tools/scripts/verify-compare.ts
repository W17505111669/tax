/**
 * 底稿逐格比对验证：构造含 1 处数值差异与 1 行单方缺失的两份底稿，核对统计口径。
 * 运行：pnpm verify:compare
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { compareWorkbooks } from "../src/index.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tax-cmp-"));

async function writeBook(file: string, rows: Array<[string, number]>, extra?: [string, number]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("归集比对");
  ws.addRow(["费用类别", "金额（元）"]);
  for (const r of rows) ws.addRow(r);
  if (extra) ws.addRow(extra);
  const p = path.join(dir, file);
  await wb.xlsx.writeFile(p);
  return p;
}

const a = await writeBook("a.xlsx", [
  ["人员人工", 860000],
  ["直接投入", 420000],
  ["折旧费用", 150000],
]);
const b = await writeBook(
  "b.xlsx",
  [
    ["人员人工", 860000],
    ["直接投入", 425000],
    ["折旧费用", 150000],
  ],
  ["无形资产摊销", 60000],
);

const result = await compareWorkbooks(a, b);
const t = result.totals;
const sheet = result.sheets[0]!;

// 记录级比对：主键=费用类别，公共列=金额（元）；仅B 的行按 字段数+1 计
const okTotals = t.compared === 5 && t.matched === 2 && t.mismatched === 1 && t.onlyA === 0 && t.onlyB === 2;
const okAccuracy = t.accuracyPercent === 40 && sheet.accuracyPercent === 40;
const mismatch = sheet.diffs.find((d) => d.kind === "mismatch");
const okMismatchCell =
  mismatch?.address === "直接投入/金额（元）" && mismatch?.a === 420000 && mismatch?.b === 425000;

// 容差 5000 元（500000 分）时该差异应判为一致
const tolerant = await compareWorkbooks(a, b, { toleranceCents: 500000 });
const okTolerance = tolerant.totals.mismatched === 0 && tolerant.totals.matched === 3;

// 地址模式（同版式）对照
const addr = await compareWorkbooks(a, b, { align: "address" });
const okAddress = addr.totals.mismatched === 1 && addr.sheets[0]?.mode === "address";

console.log(
  `[verify] compared=${t.compared} matched=${t.matched} mismatched=${t.mismatched} onlyA=${t.onlyA} onlyB=${t.onlyB} accuracy=${t.accuracyPercent}%`,
);
console.log(
  `[verify] totals=${okTotals} accuracy=${okAccuracy} mismatchCell=${okMismatchCell}(${mismatch?.address}) tolerance=${okTolerance}`,
);
console.log(`[verify] addressMode mismatched=${addr.totals.mismatched} mode=${addr.sheets[0]?.mode} ok=${okAddress}`);

const pass = okTotals && okAccuracy && okMismatchCell && okTolerance && okAddress;
console.log(pass ? "\n[PASS] 底稿逐格比对统计口径正确。" : "\n[FAIL] 比对工具验证未通过。");

fs.rmSync(dir, { recursive: true, force: true });
process.exitCode = pass ? 0 : 1;
