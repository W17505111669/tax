/**
 * 合同/发票字段抽取确定性验证。
 * 运行：pnpm verify:extract
 */
import { extractContractFields, extractInvoiceFields } from "../src/index.ts";

const invoiceText = [
  "电子发票（增值税专用发票）",
  "发票代码：1100213130",
  "发票号码：08654321",
  "开票日期：2025 年 6 月 18 日",
  "销售方名称：江苏某建筑工程有限公司",
  "金额：5,000,000.00",
  "税额：450,000.00",
  "价税合计（小写）：5,450,000.00",
  "合同编号：HT-001",
].join("\n");

const inv = extractInvoiceFields(invoiceText);
const okInv =
  inv.invoiceNo === "08654321" &&
  inv.invoiceCode === "1100213130" &&
  inv.date === "2025-06-18" &&
  (inv.sellerName ?? "").includes("江苏某建筑工程") &&
  inv.amountYuan === "5000000.00" &&
  inv.taxAmountYuan === "450000.00" &&
  inv.totalYuan === "5450000.00" &&
  inv.contractNo === "HT-001" &&
  inv.confidence === "high" &&
  inv.missing.length === 0;

const contractText = [
  "建设工程施工合同",
  "合同编号：HT-001",
  "合同名称：云璟花园一期总承包合同",
  "发包方（甲方）：某房地产开发有限公司",
  "承包方（乙方）：江苏某建筑工程有限公司",
  "合同金额：12,000,000.00 元",
].join("\n");

const con = extractContractFields(contractText);
const okCon =
  con.contractNo === "HT-001" &&
  (con.contractName ?? "").includes("云璟花园") &&
  (con.partyA ?? "").includes("房地产开发") &&
  (con.partyB ?? "").includes("江苏某建筑工程") &&
  con.amountYuan === "12000000.00" &&
  con.missing.length === 0;

const empty = extractInvoiceFields("（空白扫描件，无文本）");
const okEmpty = empty.confidence === "low" && empty.missing.includes("发票号码");

console.log(`[verify] invoice=${okInv} contract=${okCon} emptyDegraded=${okEmpty}`);
console.log(`[verify] invoiceFields=${JSON.stringify(inv)}`);
const pass = okInv && okCon && okEmpty;
console.log(pass ? "\n[PASS] 合同/发票字段抽取可用。" : "\n[FAIL] 字段抽取验证未通过。");
process.exitCode = pass ? 0 : 1;
