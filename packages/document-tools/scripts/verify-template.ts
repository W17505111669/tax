/**
 * Phase 3 验证脚本：模板检查 + 保留式填列的确定性验证。
 * 运行：pnpm verify:template
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { fillTemplate, inspectTemplate } from "../src/index.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tax-tpl-"));
const templatePath = path.join(dir, "template.xlsx");

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("清算底稿");
ws.mergeCells("A1:E1");
ws.getCell("A1").value = "土地增值税清算工作底稿";
ws.addRow([]);
ws.addRow(["合同编号", "合同名称", "合同金额（元）", "关联发票合计（元）", "差异（元）"]);
for (let r = 4; r <= 6; r += 1) ws.getCell(`E${r}`).value = { formula: `C${r}-D${r}` };
ws.getCell("C7").value = { formula: "SUM(C4:C6)" };
await wb.xlsx.writeFile(templatePath);
const hashBefore = crypto.createHash("sha256").update(fs.readFileSync(templatePath)).digest("hex");

const inspection = await inspectTemplate(templatePath);
const sheet = inspection.sheets[0]!;
const okInspect =
  sheet.mergedRanges.some((m) => m.includes("A1")) &&
  sheet.formulaCells.some((f) => f.cell === "E4") &&
  sheet.formulaCells.some((f) => f.cell === "C7");
console.log(`[verify] inspect merged=${sheet.mergedRanges.join(";")} formulas=${sheet.formulaCells.map((f) => f.cell).join(",")}`);

const result = await fillTemplate(templatePath, dir, "filled.xlsx", [
  { sheet: "清算底稿", cell: "A4", value: "HT-001" },
  { sheet: "清算底稿", cell: "C4", value: 12000000 },
  { sheet: "清算底稿", cell: "D4", value: 11900000 },
]);
const okFill = result.written === 3 && result.preservedFormulas === 4;

const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.readFile(result.outputPath);
const ws2 = wb2.getWorksheet("清算底稿")!;
const okValues = ws2.getCell("A4").value === "HT-001" && ws2.getCell("C4").value === 12000000;
const e4 = ws2.getCell("E4").value as { formula?: string } | undefined;
const okFormulaKept = e4?.formula === "C4-D4";
const mergedOf = (w: ExcelJS.Worksheet) =>
  ((w as unknown as { model?: { merges?: string[] } }).model?.merges ?? []).length;
const okMergeKept = mergedOf(ws2) === mergedOf(ws);

let okReject = false;
try {
  await fillTemplate(templatePath, dir, "bad.xlsx", [{ sheet: "清算底稿", cell: "E4", value: 1 }]);
} catch (err) {
  okReject = err instanceof Error && err.message.includes("拒绝覆盖公式单元格");
}

const hashAfter = crypto.createHash("sha256").update(fs.readFileSync(templatePath)).digest("hex");
const okOriginalUntouched = hashBefore === hashAfter;

console.log(
  `[verify] inspect=${okInspect} fill=${okFill} values=${okValues} formulaKept=${okFormulaKept} mergeKept=${okMergeKept} rejectFormulaWrite=${okReject} originalUntouched=${okOriginalUntouched}`,
);

const pass = okInspect && okFill && okValues && okFormulaKept && okMergeKept && okReject && okOriginalUntouched;
console.log(pass ? "\n[PASS] 模板检查与保留式填列可用。" : "\n[FAIL] 模板工具验证未通过。");

fs.rmSync(dir, { recursive: true, force: true });
process.exitCode = pass ? 0 : 1;
