/** 生成演示用研发费用辅助账/财务明细账样例 Excel（合成数据，仅用于开发验证）。 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const out = path.join(root, "data", "demo", "研发费用辅助账-样例.xlsx");

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("辅助账");
ws.addRow(["类别", "金额（元）"]);
ws.addRow(["人员人工", 860000]);
ws.addRow(["直接投入", 420000]);
ws.addRow(["折旧", 150000]);
ws.addRow(["无形资产摊销", 60000]);
ws.addRow(["新产品设计费", 90000]);
ws.addRow(["其他相关费用", 180000]);

const ws2 = wb.addWorksheet("财务明细账");
ws2.addRow(["类别", "金额（元）"]);
ws2.addRow(["人员人工", 860000]);
ws2.addRow(["直接投入", 880000]);
ws2.addRow(["折旧", 150000]);
ws2.addRow(["无形资产摊销", 60000]);
ws2.addRow(["新产品设计费", 90000]);
ws2.addRow(["其他相关费用", 170000]);

await wb.xlsx.writeFile(out);
console.log("written:", out);
