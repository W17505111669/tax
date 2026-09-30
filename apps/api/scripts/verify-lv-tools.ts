/**
 * 验证脚本：土增智填的三个业务工具（合同发票关联 / 发票账面关联 / 金额一致性检查）。
 *
 * 这个 Agent 此前只有 typecheck、没有验证脚本，工具输出改了字段也没有断言拦着：给
 * match_contract_invoice 补总计字段时，只能靠一次性直接调用确认，进不了门禁。
 * 金额类输出尤其要有断言——结论里引用的合计数与差额必须能在工具结果里找到出处，
 * 否则金额溯源就把它们判成待人工确认（实测 ff4c9a3c 的 4 处待确认全是合计行）。
 *
 * 运行：pnpm verify:lvtools
 */
import {
  checkAmountConsistencyTool,
  matchContractInvoiceTool,
  matchInvoiceLedgerTool,
  normalizeCode,
} from "../../../agents/land-vat/tools/lv-tools.ts";

let checks = 0;
const failures: string[] = [];

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

function ok(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDetails = any;
const detailsOf = async (tool: { execute: (id: string, p: never) => Promise<unknown> }, params: unknown): Promise<AnyDetails> =>
  ((await tool.execute("verify", params as never)) as { details?: AnyDetails }).details;

// 1) 合同发票关联：逐份合同的金额与差异 + 三个总计
const contracts = [
  { contractNo: "HT-001", contractName: "总承包", amountYuan: "12000000.00" },
  { contractNo: "HT-002", contractName: "分包", amountYuan: "10300000.00" },
  { contractNo: "HT-003", contractName: "尚未开票", amountYuan: "1500000.00" },
];
const invoices = [
  { invoiceNo: "FP-001", contractNo: " ht-001 ", amountYuan: "11900000.00", taxAmountYuan: "1071000.00" },
  { invoiceNo: "FP-002", contractNo: "HT-002", amountYuan: "8200000.00", taxAmountYuan: "738000.00" },
  { invoiceNo: "FP-003", contractNo: "HT-002", amountYuan: "2100000.00", taxAmountYuan: "189000.00" },
  { invoiceNo: "FP-004", contractNo: "", amountYuan: "500000.00" },
  { invoiceNo: "FP-005", contractNo: "HT-999", amountYuan: "300000.00" },
];
const d = await detailsOf(matchContractInvoiceTool, { projectName: "样例项目", contracts, invoices });
expect("合同份数与发票张数如实回报", [d.contractCount, d.invoiceCount], [3, 5]);
expect("合同号归一后仍能关联（小写与前后空格）", d.matched[0].invoiceTotalYuan, "11900000.00");
expect("金额不一致判 difference_pending 并给出差额", [d.matched[0].status, d.matched[0].differenceYuan], [
  "difference_pending",
  "100000.00",
]);
expect("一份合同多张发票合并计数与合计", [d.matched[1].invoiceCount, d.matched[1].invoiceTotalYuan], [
  2,
  "10300000.00",
]);
expect("税额合计由程序汇总", d.matched[1].taxTotalYuan, "927000.00");
expect("金额一致判 consistent、差额为 0", [d.matched[1].status, d.matched[1].differenceYuan], ["consistent", "0.00"]);
expect("无发票合同判 no_invoice", [d.matched[2].status, d.matched[2].invoiceCount], ["no_invoice", 0]);
expect("未匹配发票分两类原因", d.unmatchedInvoices.map((u: { invoiceNo: string }) => u.invoiceNo), ["FP-004", "FP-005"]);
ok(
  "未注明合同编号与编号不在清单里分别说明原因",
  String(d.unmatchedInvoices[0].reason).includes("未注明合同编号") &&
    String(d.unmatchedInvoices[1].reason).includes("HT-999"),
  JSON.stringify(d.unmatchedInvoices),
);
expect("汇总计数", [d.summary.consistent, d.summary.differencePending, d.summary.noInvoice, d.summary.unmatchedInvoiceCount], [
  1, 1, 1, 2,
]);
// 总计是结论里最常引用的三个数，必须由程序给出，不能让模型自己加
expect("合同金额总计", d.summary.totalContractAmountYuan, "23800000.00");
expect("发票金额总计", d.summary.totalInvoiceYuan, "22200000.00");
expect("差异总计", d.summary.totalDifferenceYuan, "1600000.00");
expect(
  "差异总计 = 合同总计 − 发票总计",
  Number(d.summary.totalContractAmountYuan) - Number(d.summary.totalInvoiceYuan),
  Number(d.summary.totalDifferenceYuan),
);
expect(
  "总计等于逐份之和（合同）",
  d.summary.totalContractAmountYuan,
  d.matched
    .reduce((s: number, m: { contractAmountYuan: string }) => s + Number(m.contractAmountYuan), 0)
    .toFixed(2),
);
ok(
  "差异待核查的合同进 issues 并写明两个金额",
  d.issues.some((i: { description: string }) => i.description.includes("HT-001") && i.description.includes("100000.00")),
  JSON.stringify(d.issues),
);
ok("工具正文里给出合计行，模型不必自己加", String((await matchContractInvoiceTool.execute("v", { projectName: "样例项目", contracts, invoices } as never) as { content: Array<{ text?: string }> }).content[0]?.text ?? "").includes("合计：合同金额 23800000.00 元"));

// 重复发票号
const dup = await detailsOf(matchContractInvoiceTool, {
  projectName: "重复号项目",
  contracts: [{ contractNo: "HT-001", contractName: "总承包", amountYuan: "1000.00" }],
  invoices: [
    { invoiceNo: "FP-001", contractNo: "HT-001", amountYuan: "500.00" },
    { invoiceNo: "fp-001 ", contractNo: "HT-001", amountYuan: "500.00" },
  ],
});
expect("发票号归一后识别为疑似重复", dup.summary.duplicateCount, 1);

// 2) 发票与账面记录关联
const ledger = await detailsOf(matchInvoiceLedgerTool, {
  invoices: [
    { invoiceNo: "FP-001", contractNo: "HT-001", amountYuan: "1000000.00" },
    { invoiceNo: "FP-002", contractNo: "HT-001", amountYuan: "100.00" },
  ],
  ledgerRecords: [
    { voucherNo: "PZ-1", invoiceNo: "FP-001", amountYuan: "600000.00" },
    { voucherNo: "PZ-2", invoiceNo: "FP-001", amountYuan: "400000.00" },
    { voucherNo: "PZ-3", invoiceNo: "", amountYuan: "100.00" },
  ],
});
expect("一票多笔账面记录合并为一行", [ledger.summary.exactCount, ledger.exact[0].voucherNos], [1, ["PZ-1", "PZ-2"]]);
expect("账面合计与差额由程序算", [ledger.exact[0].ledgerAmountYuan, ledger.exact[0].differenceYuan], [
  "1000000.00",
  "0.00",
]);
expect(
  "号码缺失时按金额唯一性给候选并标待人工确认",
  [ledger.summary.candidateCount, ledger.summary.unmatchedCount],
  [1, 0],
);
expect("汇总四项计数自洽", ledger.summary.exactCount + ledger.summary.candidateCount + ledger.summary.unmatchedCount, 2);

// 3) 金额一致性检查
const consistency = await detailsOf(checkAmountConsistencyTool, {
  items: [
    { label: "合同额", expectedYuan: "1000.00", actualYuan: "1000.00" },
    { label: "发票额", expectedYuan: "1000.00", actualYuan: "990.00" },
    { label: "容差内", expectedYuan: "1000.00", actualYuan: "999.00", toleranceYuan: "1.00" },
  ],
});
expect("差异 = 实际 − 应有", consistency.rows.map((r: { differenceYuan: string }) => r.differenceYuan), [
  "0.00",
  "-10.00",
  "-1.00",
]);
expect("容差内判一致、容差外判待核查", consistency.rows.map((r: { consistent: boolean }) => r.consistent), [
  true,
  false,
  true,
]);
expect("不一致组数", consistency.inconsistentCount, 1);
expect("不一致清单只列待核查那组", consistency.inconsistent.map((r: { label: string }) => r.label), ["发票额"]);

// 4) 编号归一化：大小写、首尾空格与分隔符都不影响关联（「HT-001」与「ht 001」是同一个编号）
expect("归一化去空格、去分隔符并转大写", [normalizeCode(" ht-001 "), normalizeCode("HT 001"), normalizeCode("")], [
  "HT001",
  "HT001",
  "",
]);

console.log(`[verify] 土增智填工具检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 土增智填业务工具规则不符");
  process.exit(1);
}
console.log("[PASS] 土增智填业务工具正确（合同发票关联与总计 / 发票账面关联 / 金额一致性 / 编号归一化）");
