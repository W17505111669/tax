import fs from "node:fs/promises";
import { Type } from "typebox";
import type { ToolDefinition } from "@tax/agent-core";
import type { BusinessFile } from "@tax/shared-schemas";
import { parsePdfFile } from "./pdf-parser.ts";
import { ocrImage } from "./ocr.ts";
import type { TaskDocumentContext } from "./task-tools.ts";

export interface InvoiceFields {
  invoiceNo: string | null;
  invoiceCode: string | null;
  date: string | null;
  sellerName: string | null;
  amountYuan: string | null;
  taxAmountYuan: string | null;
  totalYuan: string | null;
  contractNo: string | null;
  confidence: "high" | "medium" | "low";
  missing: string[];
}

export interface ContractFields {
  contractNo: string | null;
  contractName: string | null;
  partyA: string | null;
  partyB: string | null;
  amountYuan: string | null;
  missing: string[];
}

const MONEY = "([0-9][0-9,]*\\.\\d{1,2})";

function first(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m && m[1] ? m[1].replace(/,/g, "").trim() : null;
}

/** 从发票文本（PDF 文本层 / OCR / txt）确定性抽取票面字段。 */
export function extractInvoiceFields(text: string): InvoiceFields {
  const invoiceNo = first(text, /发票号码[：:]\s*(\d{8,20})/);
  const invoiceCode = first(text, /发票代码[：:]\s*(\d{10,12})/);
  const dateM = /开票日期[：:]\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text);
  const date = dateM
    ? `${dateM[1]}-${String(dateM[2]).padStart(2, "0")}-${String(dateM[3]).padStart(2, "0")}`
    : null;
  const sellerName = first(text, /销售方[^名\n]{0,24}名称[：:]\s*([^\n]+)/) ?? first(text, /销\s*售\s*方[：:]\s*([^\n]+)/);
  const amountYuan = first(text, new RegExp(`(?:不含税金额|(?<!税)金\\s*额)[：:]\\s*${MONEY}`));
  const taxAmountYuan = first(text, new RegExp(`税\\s*额[：:]\\s*${MONEY}`));
  const totalYuan =
    first(text, new RegExp(`价税合计[^0-9\\n]{0,16}${MONEY}`)) ?? first(text, new RegExp(`小写[)）]?[：:]?\\s*¥?\\s*${MONEY}`));
  const contractNo = first(text, /合同编号[：:]\s*([A-Za-z0-9\-_]+)/);

  const missing: string[] = [];
  if (!invoiceNo) missing.push("发票号码");
  if (!amountYuan) missing.push("金额");
  if (!date) missing.push("开票日期");
  if (!sellerName) missing.push("销售方名称");
  if (!taxAmountYuan) missing.push("税额");

  const confidence: InvoiceFields["confidence"] =
    invoiceNo && amountYuan && date ? "high" : invoiceNo && amountYuan ? "medium" : "low";

  return { invoiceNo, invoiceCode, date, sellerName, amountYuan, taxAmountYuan, totalYuan, contractNo, confidence, missing };
}

/** 从合同文本确定性抽取关键条款字段。 */
export function extractContractFields(text: string): ContractFields {
  const contractNo = first(text, /合同编号[：:]\s*([A-Za-z0-9\-_]+)/) ?? first(text, /编\s*号[：:]\s*([A-Za-z0-9\-_]+)/);
  const contractName = first(text, /合同名称[：:]\s*([^\n]+)/) ?? first(text, /^([^\n]{4,40}(?:合同|协议))\s*$/m);
  const partyA = first(text, /(?:发包方|甲方|采购人|委托人)[（(]?[^)）\n]{0,12}[)）]?[：:]\s*([^\n]+)/);
  const partyB = first(text, /(?:承包方|乙方|供应商|受托人)[（(]?[^)）\n]{0,12}[)）]?[：:]\s*([^\n]+)/);
  const amountYuan =
    first(text, new RegExp(`(?:合同金额|合同总价|签约合同价|总价)[（(]?[^)）\n]{0,8}[)）]?[：:]\\s*¥?\\s*${MONEY}`)) ??
    first(text, new RegExp(`${MONEY}\\s*元`));
  const missing: string[] = [];
  if (!contractNo) missing.push("合同编号");
  if (!amountYuan) missing.push("合同金额");
  if (!partyB) missing.push("乙方");
  return { contractNo, contractName, partyA, partyB, amountYuan, missing };
}

async function fileText(file: BusinessFile): Promise<{ text: string; source: string }> {
  const ext = file.fileType.toLowerCase();
  if (ext === "pdf") {
    const { text } = await parsePdfFile(file.storagePath);
    return { text, source: "pdf-text" };
  }
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "bmp") {
    const buffer = new Uint8Array(await fs.readFile(file.storagePath));
    const ocr = await ocrImage(buffer);
    return { text: ocr.text, source: `ocr:${ocr.provider}` };
  }
  const text = await fs.readFile(file.storagePath, "utf8");
  return { text, source: "raw-text" };
}

/** 土增智填专属：合同/发票字段抽取工具（数据源为上传文件，而非指令口述）。 */
export function createExtractTools(ctx: TaskDocumentContext): ToolDefinition[] {
  const findFile = (fileName: string): BusinessFile => {
    const hit = ctx.files.find((f) => f.fileName === fileName);
    if (!hit) throw new Error(`上传资料中找不到文件: ${fileName}`);
    return hit;
  };

  const invoiceTool: ToolDefinition = {
    name: "parse_invoice",
    label: "发票字段抽取",
    description:
      "从上传的发票文件（PDF 文本层/图片 OCR/txt）确定性抽取票面字段：发票号码、代码、开票日期、销售方、金额、税额、价税合计、合同编号。返回缺失字段与置信度；金额不做任何换算。",
    promptSnippet: "parse_invoice: 抽取发票票面字段（号码/日期/金额/税额/销售方）",
    parameters: Type.Object({ fileName: Type.String() }),
    async execute(_id, params: { fileName: string }) {
      const file = findFile(params.fileName);
      const { text, source } = await fileText(file);
      const fields = extractInvoiceFields(text);
      const lines = [
        `发票字段抽取结果（来源 ${source}，置信度 ${fields.confidence}）：`,
        `- 发票号码：${fields.invoiceNo ?? "未识别"}`,
        `- 发票代码：${fields.invoiceCode ?? "未识别"}`,
        `- 开票日期：${fields.date ?? "未识别"}`,
        `- 销售方：${fields.sellerName ?? "未识别"}`,
        `- 金额：${fields.amountYuan ?? "未识别"} 元；税额：${fields.taxAmountYuan ?? "未识别"} 元；价税合计：${fields.totalYuan ?? "未识别"} 元`,
        `- 合同编号：${fields.contractNo ?? "未注明"}`,
        fields.missing.length > 0 ? `- 缺失字段：${fields.missing.join("、")}（需人工补录或换更清晰件）` : "- 字段完整",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: { fileName: params.fileName, source, fields } };
    },
  };

  const contractTool: ToolDefinition = {
    name: "parse_contract",
    label: "合同关键条款抽取",
    description:
      "从上传的合同文件（PDF 文本层/图片 OCR/txt）确定性抽取关键条款：合同编号、名称、甲乙双方、合同金额。返回缺失字段；金额不做任何换算。",
    promptSnippet: "parse_contract: 抽取合同编号/双方/金额等关键条款",
    parameters: Type.Object({ fileName: Type.String() }),
    async execute(_id, params: { fileName: string }) {
      const file = findFile(params.fileName);
      const { text, source } = await fileText(file);
      const fields = extractContractFields(text);
      const lines = [
        `合同条款抽取结果（来源 ${source}）：`,
        `- 合同编号：${fields.contractNo ?? "未识别"}`,
        `- 合同名称：${fields.contractName ?? "未识别"}`,
        `- 甲方：${fields.partyA ?? "未识别"}；乙方：${fields.partyB ?? "未识别"}`,
        `- 合同金额：${fields.amountYuan ?? "未识别"} 元`,
        fields.missing.length > 0 ? `- 缺失字段：${fields.missing.join("、")}` : "- 关键字段完整",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: { fileName: params.fileName, source, fields } };
    },
  };

  return [invoiceTool, contractTool];
}
