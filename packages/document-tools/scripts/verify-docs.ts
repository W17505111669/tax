/**
 * Phase 2 验证脚本：Excel/CSV 解析、Excel 工作底稿生成的确定性验证。
 * 运行：pnpm verify:docs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { generateWorkpaper, parseCsvText, parseExcelFile } from "../src/index.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tax-docs-"));

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("辅助账");
ws.addRow(["类别", "金额（元）"]);
ws.addRow(["人员人工", 860000]);
ws.addRow(["直接投入", 420000]);
const xlsxPath = path.join(dir, "aux.xlsx");
await wb.xlsx.writeFile(xlsxPath);

const sheets = await parseExcelFile(xlsxPath);
const sheet = sheets[0];
console.log(
  `[verify] sheet=${sheet?.name} rows=${sheet?.rowCount} headers=${sheet?.headers.join(",")}`,
);
const okParse =
  sheet?.rowCount === 2 &&
  sheet.rows[0]?.["类别"] === "人员人工" &&
  sheet.rows[0]?.["金额（元）"] === 860000;

const csv = parseCsvText("合同编号,金额\nHT-001,12000000\n");
const okCsv = csv[0]?.rows[0]?.["合同编号"] === "HT-001" && csv[0]?.rows[0]?.["金额"] === 12000000;

const out = await generateWorkpaper(dir, {
  fileName: "wp.xlsx",
  title: "研发费用专项审查底稿",
  meta: [{ label: "案例", value: "RD-001" }],
  sheets: [
    {
      name: "归集表",
      headers: ["类别", "金额"],
      rows: [
        ["人员人工", 860000],
        ["直接投入", 420000],
      ],
      formulas: [{ cell: "B6", formula: "SUM(B4:B5)" }],
    },
  ],
});

const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.readFile(out);
const ws2 = wb2.getWorksheet("归集表");
const titleOk = String(ws2?.getCell("A1").value) === "研发费用专项审查底稿";
const formulaCell = ws2?.getCell("B6").value as { formula?: string } | undefined;
const formulaOk = formulaCell?.formula === "SUM(B4:B5)";
const frozenOk = (ws2?.views?.[0] as { ySplit?: number } | undefined)?.ySplit === 3;

console.log(
  `[verify] parseExcel=${okParse} parseCsv=${okCsv} workpaperTitle=${titleOk} formula=${formulaOk} frozen=${frozenOk}`,
);

const pass = Boolean(okParse && okCsv && titleOk && formulaOk && frozenOk);
console.log(pass ? "\n[PASS] 文档解析与 Excel 底稿生成可用。" : "\n[FAIL] 文档工具验证未通过。");

fs.rmSync(dir, { recursive: true, force: true });
process.exitCode = pass ? 0 : 1;
