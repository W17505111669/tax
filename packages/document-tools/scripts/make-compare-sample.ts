/** 生成人工参考底稿样例（直接投入与系统口径故意差 5,000 元，用于比对演示）。 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const out = path.join(root, "data", "demo", "人工参考底稿-样例.xlsx");

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("归集比对");
ws.addRow(["费用类别", "金额（元）"]);
ws.addRow(["人员人工", 860000]);
ws.addRow(["直接投入", 425000]);
ws.addRow(["折旧费用", 150000]);

await wb.xlsx.writeFile(out);
console.log("written:", out);
