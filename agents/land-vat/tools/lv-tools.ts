import { Type } from "typebox";
import { centsToYuan, sumCents, yuanToCents } from "@tax/shared-schemas";
import type { ToolDefinition } from "@tax/agent-core";

/** 编号归一化：去空格、去连接符、统一大写，避免「HT-001」与「ht 001」判为不同。 */
export function normalizeCode(value: string | undefined | null): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s\-_—–－]/g, "");
}

const ContractSchema = Type.Object({
  contractNo: Type.String(),
  contractName: Type.String(),
  amountYuan: Type.String({ description: "合同金额（元），不含税口径需与发票口径一致" }),
  supplierName: Type.Optional(Type.String()),
});

const InvoiceSchema = Type.Object({
  invoiceNo: Type.String(),
  invoiceCode: Type.Optional(Type.String()),
  contractNo: Type.Optional(Type.String({ description: "发票上注明的合同编号，可能为空" })),
  amountYuan: Type.String({ description: "不含税金额（元）" }),
  taxAmountYuan: Type.Optional(Type.String({ description: "税额（元）" })),
  supplierName: Type.Optional(Type.String()),
  invoiceDate: Type.Optional(Type.String()),
});

const LedgerRecordSchema = Type.Object({
  voucherNo: Type.String(),
  invoiceNo: Type.Optional(Type.String()),
  amountYuan: Type.String(),
  summary: Type.Optional(Type.String()),
});

interface Contract {
  contractNo: string;
  contractName: string;
  amountYuan: string;
  supplierName?: string;
}
interface Invoice {
  invoiceNo: string;
  invoiceCode?: string;
  contractNo?: string;
  amountYuan: string;
  taxAmountYuan?: string;
  supplierName?: string;
  invoiceDate?: string;
}
interface LedgerRecord {
  voucherNo: string;
  invoiceNo?: string;
  amountYuan: string;
  summary?: string;
}

/**
 * 合同 ↔ 发票关联：支持一对一、一对多，输出汇总金额、差异与异常清单。
 */
export const matchContractInvoiceTool: ToolDefinition = {
  name: "match_contract_invoice",
  label: "合同发票关联",
  description:
    "按合同编号把发票关联到工程合同，支持一份合同对应多张发票。输出每份合同的发票清单、发票金额合计、合同与发票差异、未匹配发票、无发票合同、疑似重复发票号码。金额汇总由程序完成。",
  promptSnippet: "match_contract_invoice: 按合同编号关联发票并汇总金额、识别差异与重复",
  parameters: Type.Object({
    projectName: Type.String(),
    contracts: Type.Array(ContractSchema),
    invoices: Type.Array(InvoiceSchema),
  }),
  async execute(_toolCallId, params: { projectName: string; contracts: Contract[]; invoices: Invoice[] }) {
    const contractByKey = new Map<string, Contract>();
    for (const c of params.contracts) contractByKey.set(normalizeCode(c.contractNo), c);

    // 发票号码查重（号码+代码组合）
    const seen = new Map<string, Invoice[]>();
    for (const inv of params.invoices) {
      const key = `${normalizeCode(inv.invoiceNo)}|${normalizeCode(inv.invoiceCode)}`;
      seen.set(key, [...(seen.get(key) ?? []), inv]);
    }
    const duplicates = [...seen.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([key, list]) => ({
        key,
        invoiceNo: list[0]?.invoiceNo,
        count: list.length,
        amountsYuan: list.map((i) => i.amountYuan),
      }));

    const matched: Array<{
      contractNo: string;
      contractName: string;
      contractAmountYuan: string;
      invoiceCount: number;
      invoiceNos: string[];
      invoiceTotalYuan: string;
      taxTotalYuan: string;
      differenceYuan: string;
      status: "consistent" | "difference_pending" | "no_invoice";
    }> = [];

    const unmatchedInvoices: Array<Invoice & { reason: string }> = [];

    for (const contract of params.contracts) {
      const key = normalizeCode(contract.contractNo);
      const list = params.invoices.filter((i) => normalizeCode(i.contractNo) === key && key !== "");
      const contractCents = yuanToCents(contract.amountYuan);
      const invoiceCents = sumCents(list.map((i) => yuanToCents(i.amountYuan)));
      const taxCents = sumCents(list.map((i) => yuanToCents(i.taxAmountYuan ?? "0")));
      const diff = contractCents - invoiceCents;
      matched.push({
        contractNo: contract.contractNo,
        contractName: contract.contractName,
        contractAmountYuan: centsToYuan(contractCents),
        invoiceCount: list.length,
        invoiceNos: list.map((i) => i.invoiceNo),
        invoiceTotalYuan: centsToYuan(invoiceCents),
        taxTotalYuan: centsToYuan(taxCents),
        differenceYuan: centsToYuan(diff),
        status: list.length === 0 ? "no_invoice" : diff === 0 ? "consistent" : "difference_pending",
      });
    }

    for (const inv of params.invoices) {
      const key = normalizeCode(inv.contractNo);
      if (!key) {
        unmatchedInvoices.push({ ...inv, reason: "发票未注明合同编号" });
      } else if (!contractByKey.has(key)) {
        unmatchedInvoices.push({ ...inv, reason: `合同编号 ${inv.contractNo} 未在合同清单中找到` });
      }
    }

    const issues = [
      ...matched
        .filter((m) => m.status === "difference_pending")
        .map((m) => ({
          issueType: "金额差异",
          description: `合同「${m.contractNo} ${m.contractName}」合同金额 ${m.contractAmountYuan} 元，关联 ${m.invoiceCount} 张发票合计 ${m.invoiceTotalYuan} 元，差异 ${m.differenceYuan} 元，待核查。`,
          evidence: [`contract:${m.contractNo}`, ...m.invoiceNos.map((n) => `invoice:${n}`)],
          requiresReview: true,
        })),
      ...matched
        .filter((m) => m.status === "no_invoice")
        .map((m) => ({
          issueType: "资料缺失",
          description: `合同「${m.contractNo} ${m.contractName}」未取得任何对应发票。`,
          evidence: [`contract:${m.contractNo}`],
          requiresReview: true,
        })),
      ...unmatchedInvoices.map((i) => ({
        issueType: "未匹配发票",
        description: `发票 ${i.invoiceNo}（${i.amountYuan} 元）未匹配到合同：${i.reason}。`,
        evidence: [`invoice:${i.invoiceNo}`],
        requiresReview: true,
      })),
      ...duplicates.map((d) => ({
        issueType: "疑似重复发票",
        description: `发票号码 ${d.invoiceNo} 出现 ${d.count} 次，金额 ${d.amountsYuan.join(" / ")} 元，需核实是否重复入账。`,
        evidence: [`invoice:${d.invoiceNo}`],
        requiresReview: true,
      })),
    ];

    const details = {
      projectName: params.projectName,
      contractCount: params.contracts.length,
      invoiceCount: params.invoices.length,
      matched,
      unmatchedInvoices,
      duplicates,
      issues,
      summary: {
        consistent: matched.filter((m) => m.status === "consistent").length,
        differencePending: matched.filter((m) => m.status === "difference_pending").length,
        noInvoice: matched.filter((m) => m.status === "no_invoice").length,
        unmatchedInvoiceCount: unmatchedInvoices.length,
        duplicateCount: duplicates.length,
      },
    };

    const text = [
      `项目「${params.projectName}」合同发票关联结果：`,
      `- 合同 ${details.contractCount} 份，发票 ${details.invoiceCount} 张`,
      `- 金额一致: ${details.summary.consistent} 份；存在差异待核查: ${details.summary.differencePending} 份；无发票: ${details.summary.noInvoice} 份`,
      `- 未匹配发票: ${details.summary.unmatchedInvoiceCount} 张；疑似重复: ${details.summary.duplicateCount} 组`,
      ...matched.map(
        (m) =>
          `  · ${m.contractNo} ${m.contractName} | 合同 ${m.contractAmountYuan} | 发票 ${m.invoiceCount} 张合计 ${m.invoiceTotalYuan} | 差异 ${m.differenceYuan} | ${m.status}`,
      ),
      ...issues.map((i, idx) => `  ${idx + 1}. [${i.issueType}] ${i.description}`),
    ].join("\n");

    return { content: [{ type: "text", text }], details };
  },
};

/**
 * 发票 ↔ 账面记录匹配：优先按发票号码精确匹配（支持一对多），
 * 号码缺失时按金额唯一性给出候选，并强制标记为待人工确认。
 */
export const matchInvoiceLedgerTool: ToolDefinition = {
  name: "match_invoice_ledger",
  label: "发票账簿匹配",
  description:
    "把发票与财务账面记录关联。先按发票号码精确匹配（支持一张发票对应多笔账面记录），号码缺失时按金额唯一性给出候选并标记待人工确认。输出已匹配、待人工确认、未匹配三类结果。",
  promptSnippet: "match_invoice_ledger: 发票与账面记录关联，输出匹配类型与待确认项",
  parameters: Type.Object({
    invoices: Type.Array(InvoiceSchema),
    ledgerRecords: Type.Array(LedgerRecordSchema),
  }),
  async execute(_toolCallId, params: { invoices: Invoice[]; ledgerRecords: LedgerRecord[] }) {
    const byInvoiceNo = new Map<string, LedgerRecord[]>();
    for (const rec of params.ledgerRecords) {
      const key = normalizeCode(rec.invoiceNo);
      if (!key) continue;
      byInvoiceNo.set(key, [...(byInvoiceNo.get(key) ?? []), rec]);
    }

    const exact: unknown[] = [];
    const candidates: unknown[] = [];
    const unmatched: unknown[] = [];
    const usedVouchers = new Set<string>();

    for (const inv of params.invoices) {
      const key = normalizeCode(inv.invoiceNo);
      const recs = byInvoiceNo.get(key) ?? [];
      if (recs.length > 0) {
        recs.forEach((r) => usedVouchers.add(r.voucherNo));
        const recCents = sumCents(recs.map((r) => yuanToCents(r.amountYuan)));
        const invCents = yuanToCents(inv.amountYuan);
        exact.push({
          invoiceNo: inv.invoiceNo,
          invoiceAmountYuan: inv.amountYuan,
          voucherNos: recs.map((r) => r.voucherNo),
          ledgerAmountYuan: centsToYuan(recCents),
          differenceYuan: centsToYuan(invCents - recCents),
          matchType: "exact_invoice_no",
          requiresReview: invCents !== recCents,
        });
        continue;
      }

      // 退化为金额候选：只有唯一一笔金额相同的未使用记录才作为候选
      const invCents = yuanToCents(inv.amountYuan);
      const amountMatches = params.ledgerRecords.filter(
        (r) => !usedVouchers.has(r.voucherNo) && yuanToCents(r.amountYuan) === invCents,
      );
      if (amountMatches.length === 1) {
        const rec = amountMatches[0]!;
        usedVouchers.add(rec.voucherNo);
        candidates.push({
          invoiceNo: inv.invoiceNo,
          invoiceAmountYuan: inv.amountYuan,
          voucherNos: [rec.voucherNo],
          ledgerAmountYuan: rec.amountYuan,
          differenceYuan: "0.00",
          matchType: "amount_candidate",
          requiresReview: true,
          note: "账面记录未注明发票号码，仅凭金额唯一匹配推断，需人工确认",
        });
      } else {
        unmatched.push({
          invoiceNo: inv.invoiceNo,
          invoiceAmountYuan: inv.amountYuan,
          matchType: "unmatched",
          requiresReview: true,
          reason:
            amountMatches.length === 0
              ? "账面记录中未找到发票号码或金额一致的记录"
              : `存在 ${amountMatches.length} 笔金额相同的候选记录，无法唯一确定`,
          candidateVoucherNos: amountMatches.map((r) => r.voucherNo),
        });
      }
    }

    const orphanLedger = params.ledgerRecords
      .filter((r) => !usedVouchers.has(r.voucherNo))
      .map((r) => ({
        voucherNo: r.voucherNo,
        amountYuan: r.amountYuan,
        summary: r.summary ?? "",
        reason: "账面记录未关联到任何发票",
      }));

    const details = {
      exact,
      candidates,
      unmatched,
      orphanLedger,
      summary: {
        exactCount: exact.length,
        candidateCount: candidates.length,
        unmatchedCount: unmatched.length,
        orphanLedgerCount: orphanLedger.length,
      },
    };

    const text = [
      "发票与账面记录匹配结果：",
      `- 精确匹配: ${exact.length} 张；待人工确认: ${candidates.length} 张；未匹配: ${unmatched.length} 张；孤立账面记录: ${orphanLedger.length} 笔`,
    ].join("\n");

    return { content: [{ type: "text", text }], details };
  },
};

/**
 * 金额一致性检查：对多组「应有金额 / 实际金额」做确定性比对。
 */
export const checkAmountConsistencyTool: ToolDefinition = {
  name: "check_amount_consistency",
  label: "金额一致性检查",
  description:
    "对多组金额做确定性比对，输入项目名称、应有金额、实际金额与容差，输出每组的差异、是否一致及待核查结论。用于底稿金额与源数据核对。",
  promptSnippet: "check_amount_consistency: 多组金额差异比对",
  parameters: Type.Object({
    items: Type.Array(
      Type.Object({
        label: Type.String(),
        expectedYuan: Type.String(),
        actualYuan: Type.String(),
        toleranceYuan: Type.Optional(Type.String({ description: "容差（元），默认 0.00" })),
      }),
      { minItems: 1 },
    ),
  }),
  async execute(_toolCallId, params: {
    items: Array<{ label: string; expectedYuan: string; actualYuan: string; toleranceYuan?: string }>;
  }) {
    const rows = params.items.map((item) => {
      const expected = yuanToCents(item.expectedYuan);
      const actual = yuanToCents(item.actualYuan);
      const tolerance = yuanToCents(item.toleranceYuan ?? "0");
      const diff = actual - expected;
      return {
        label: item.label,
        expectedYuan: centsToYuan(expected),
        actualYuan: centsToYuan(actual),
        differenceYuan: centsToYuan(diff),
        consistent: Math.abs(diff) <= tolerance,
      };
    });
    const inconsistent = rows.filter((r) => !r.consistent);
    const details = { rows, inconsistentCount: inconsistent.length, inconsistent };
    const text = [
      `金额一致性检查：共 ${rows.length} 组，不一致 ${inconsistent.length} 组。`,
      ...rows.map(
        (r) =>
          `  · ${r.label} | 应有 ${r.expectedYuan} | 实际 ${r.actualYuan} | 差异 ${r.differenceYuan} | ${r.consistent ? "一致" : "待核查"}`,
      ),
    ].join("\n");
    return { content: [{ type: "text", text }], details };
  },
};

export const landVatTools = [matchContractInvoiceTool, matchInvoiceLedgerTool, checkAmountConsistencyTool];
