/** 生成合成土增清算底稿模板（含合并标题、公式列与合计公式），仅用于开发验证。 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const out = path.join(root, "data", "demo", "土增清算底稿-合成模板.xlsx");

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("清算底稿");

ws.mergeCells("A1:E1");
ws.getCell("A1").value = "土地增值税清算工作底稿（开发成本·合同发票关联）";
ws.getCell("A1").font = { bold: true, size: 14 };

ws.addRow([]);
ws.addRow(["合同编号", "合同名称", "合同金额（元）", "关联发票合计（元）", "差异（元）"]);
for (let r = 4; r <= 8; r += 1) {
  ws.getCell(`E${r}`).value = { formula: `C${r}-D${r}` };
}
ws.getCell("A10").value = "合计";
ws.getCell("C10").value = { formula: "SUM(C4:C8)" };
ws.getCell("D10").value = { formula: "SUM(D4:D8)" };
ws.getCell("E10").value = { formula: "SUM(E4:E8)" };
ws.mergeCells("A12:E12");
ws.getCell("A12").value = "备注：差异列为公式自动计算，填列时不得覆盖。";

await wb.xlsx.writeFile(out);
console.log("written:", out);
