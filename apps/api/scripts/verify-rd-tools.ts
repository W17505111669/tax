/**
 * 验证脚本：智研税审的两个业务工具（加计扣除测算 / 归集核查）。
 *
 * 这个 Agent 此前只有 verify:agents 检查工具名与重名，金额规则本身没有断言：给
 * calculate_rd_adjustment 补双口径对照时，只能靠一次性直接调用确认，进不了门禁。
 * 金额类输出必须有断言——结论里引用的限额、基数与差额要能在工具结果里找到出处，
 * 否则金额溯源就把它们判成待人工确认（实测 17a56468 的 3 处待确认全是第二个口径与两口径差额，
 * 都是模型自己算的）。最后一组断言直接把工具正文喂给溯源函数，要求零未溯源。
 *
 * 运行：pnpm verify:rdtools
 */
import { calculateRdAdjustmentTool, checkRdExpensesTool, RD_CATEGORIES } from "../../../agents/rd-audit/tools/rd-tools.ts";
import { traceAmounts, TEXT_AMOUNT_TOOLS } from "../../web/src/amount-trace.ts";

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

// 工具的 execute 由 SDK 定义（除 id 与入参外还有若干上下文参数），这里只关心 details 与正文，
// 因此按宽松签名包装一次，避免为了跑断言去凑 SDK 的完整参数表（与 verify-lv-tools.ts 同一做法）
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTool = { execute: (...args: any[]) => Promise<{ details?: any; content?: Array<{ text?: string }> }> };
const asTool = (t: unknown): AnyTool => t as AnyTool;
const calcTool = asTool(calculateRdAdjustmentTool);
const checkTool = asTool(checkRdExpensesTool);
const runOf = async (tool: AnyTool, params: unknown) => await tool.execute("verify", params);
const detailsOf = async (tool: AnyTool, params: unknown): Promise<any> => (await runOf(tool, params)).details;
const textOf = async (tool: AnyTool, params: unknown): Promise<string> =>
  String((await runOf(tool, params)).content?.[0]?.text ?? "");

/** 制造业样例：前五类合计 1,580,000 元，其他相关费用 180,000 元（超限） */
const AUX = [
  { category: "personnel", amountYuan: "860000.00" },
  { category: "direct", amountYuan: "420000.00" },
  { category: "depreciation", amountYuan: "150000.00" },
  { category: "intangible", amountYuan: "60000.00" },
  { category: "design", amountYuan: "90000.00" },
  { category: "other", amountYuan: "180000.00" },
];
/** 财务明细账口径：直接投入多 460,000 元（前五类 2,040,000），其他相关费用 170,000 元（未超限） */
const FIN = AUX.map((i) => (i.category === "direct" ? { ...i, amountYuan: "880000.00" } : i)).map((i) =>
  i.category === "other" ? { ...i, amountYuan: "170000.00" } : i,
);

// 1) 单口径测算：限额规则与超限部分
const base = { projectName: "高精度数控主轴研发", year: 2025, deductionRatePercent: 100, expenses: AUX };
const d = await detailsOf(calcTool, base);
expect("六大类逐项回报", d.byCategory.map((c: { category: string }) => c.category), [...RD_CATEGORIES]);
expect("前五类合计由程序求和", d.firstFiveTotalYuan, "1580000.00");
expect("限额 = 前五类 × 10% ÷ 90%，向下取整到分", d.otherLimitYuan, "175555.55");
expect("可加计的其他相关费用取实际与限额的较小值", d.otherAllowedYuan, "175555.55");
expect("超限部分不得加计", d.otherExceededYuan, "4444.45");
expect("可加计扣除基数 = 前五类 + 可加计的其他相关费用", d.deductibleBaseYuan, "1755555.55");
expect("100% 比例下加计扣除额等于基数", d.deductionYuan, "1755555.55");
expect("限额规则原文随结果给出", d.limitRule.includes("前五类费用之和"), true);
ok("未传对照口径时不输出 comparison", d.comparison === undefined);
expect("未传 label 时主口径名为「主口径」", d.label, "主口径");

// 2) 未超限与 120% 比例（集成电路、工业母机）
const under = await detailsOf(calcTool, {
  ...base,
  expenses: AUX.map((i) => (i.category === "other" ? { ...i, amountYuan: "100000.00" } : i)),
});
expect("未超限时可加计额等于实际发生额", [under.otherAllowedYuan, under.otherExceededYuan], ["100000.00", "0.00"]);
const rate120 = await detailsOf(calcTool, { ...base, deductionRatePercent: 120 });
expect("120% 比例按基数乘比例向下取整", rate120.deductionYuan, "2106666.66");

// 3) 双口径对照：两口径各自的数与逐项差额全部由工具给出
const cmp = await detailsOf(calcTool, {
  ...base,
  label: "辅助账口径",
  alternative: { label: "财务明细账口径", expenses: FIN },
});
expect("对照表带口径名", [cmp.comparison.primary.label, cmp.comparison.alternative.label], [
  "辅助账口径",
  "财务明细账口径",
]);
expect("差额口径名写明方向", cmp.comparison.deltaLabel, "财务明细账口径 - 辅助账口径");
expect("第二口径前五类合计", cmp.comparison.alternative.firstFiveTotalYuan, "2040000.00");
expect("第二口径限额", cmp.comparison.alternative.otherLimitYuan, "226666.66");
expect("第二口径未超限", [cmp.comparison.alternative.otherAllowedYuan, cmp.comparison.alternative.otherExceededYuan], [
  "170000.00",
  "0.00",
]);
expect("第二口径基数与加计额", [cmp.comparison.alternative.deductibleBaseYuan, cmp.comparison.alternative.deductionYuan], [
  "2210000.00",
  "2210000.00",
]);
expect("两口径加计扣除额差额由程序相减", cmp.comparison.delta.deductionYuan, "454444.45");
expect("两口径基数差额", cmp.comparison.delta.deductibleBaseYuan, "454444.45");
expect("两口径前五类差额", cmp.comparison.delta.firstFiveTotalYuan, "460000.00");
expect("负差额如实带符号", cmp.comparison.delta.otherActualYuan, "-10000.00");
expect("顶层字段与对照表主口径一致，不会一处一个数", [
  cmp.firstFiveTotalYuan === cmp.comparison.primary.firstFiveTotalYuan,
  cmp.deductionYuan === cmp.comparison.primary.deductionYuan,
  cmp.otherLimitYuan === cmp.comparison.primary.otherLimitYuan,
], [true, true, true]);
expect("传了 label 就按调用方的口径名回报", cmp.label, "辅助账口径");

// 4) 正文：对照表要能被模型整段照抄
const cmpText = await textOf(calcTool, {
  ...base,
  label: "辅助账口径",
  alternative: { label: "财务明细账口径", expenses: FIN },
});
ok("正文给出两口径对照表头", cmpText.includes("| 项目 | 辅助账口径 | 财务明细账口径 | 差额 |"));
ok("正文对照表含加计扣除额差额", cmpText.includes("| 加计扣除额 | 1755555.55 | 2210000.00 | 454444.45 |"));
ok("正文注明差额由工具计算", cmpText.includes("由工具计算"));
const baseText = await textOf(calcTool, base);
ok("单口径正文首行保持原样，既有消费方不受影响", baseText.startsWith("项目「高精度数控主轴研发」2025 年度研发费用加计扣除测算结果："));
ok("单口径正文不含对照表", !baseText.includes("两口径对照"));

// 5) 关键门禁：工具正文里的每一个金额都能在工具自己的结果里找到出处。
// 模型照抄正文写结论时，金额溯源必须零未溯源，否则又会挂出「待人工确认」。
for (const [name, text, details] of [
  ["单口径", baseText, d],
  ["双口径对照", cmpText, cmp],
] as Array<[string, string, unknown]>) {
  const t = traceAmounts(text, [details], "", []);
  expect(
    `${name}正文金额全部可溯源`,
    t.untraced.map((u) => u.raw),
    [],
  );
  ok(`${name}正文确实扫到了金额`, t.total > 5, `total=${t.total}`);
}
ok("测算工具不在按正文扫描名单里（结果是结构化数值，不需要扫正文）", !TEXT_AMOUNT_TOOLS.has("calculate_rd_adjustment"));

// 6) 归集核查：账账差异、辅助账遗漏、负数与资料缺失
const chk = await detailsOf(checkTool, {
  projectName: "归集核查样例",
  auxiliaryLedger: [
    { category: "personnel", amountYuan: "500000.00" },
    { category: "direct", amountYuan: "200000.00" },
    { category: "other", amountYuan: "30000.00" },
  ],
  financialLedger: [
    { category: "personnel", amountYuan: "500000.00" },
    { category: "direct", amountYuan: "260000.00" },
    { category: "depreciation", amountYuan: "-5000.00" },
    // 辅助账完全没归集这一类，用来触发「辅助账遗漏」；负数那类只触发「异常金额」，
    // 因为遗漏的判据是 财务明细账 > 0，负数不满足（两类的判据不同，要分开造数据）
    { category: "design", amountYuan: "20000.00" },
    { category: "other", amountYuan: "30000.00" },
  ],
  documents: [
    { name: "立项决议", provided: true },
    { name: "研发人员名单", provided: false },
  ],
});
expect("逐类别给出两账金额与差异", chk.comparison.map((c: { differenceYuan: string }) => c.differenceYuan), [
  "0.00",
  "-60000.00",
  "5000.00",
  "0.00",
  "-20000.00",
  "0.00",
]);
expect("两账合计与合计差异由程序求和", [chk.auxiliaryTotalYuan, chk.financialTotalYuan, chk.totalDifferenceYuan], [
  "730000.00",
  "805000.00",
  "-75000.00",
]);
const types = chk.issues.map((i: { issueType: string }) => i.issueType);
ok("账账差异入待复核清单", types.includes("账账差异"));
ok("负数金额识别为异常金额", types.includes("异常金额"));
ok("辅助账未归集识别为遗漏", types.includes("辅助账遗漏"));
ok("未取得的留存备查资料识别为资料缺失", types.includes("资料缺失"));
expect("问题条数与清单一致", chk.issueCount, chk.issues.length);
expect("每条问题都要求人工复核", chk.issues.every((i: { requiresReview: boolean }) => i.requiresReview), true);
ok(
  "核查正文给出合计行，模型不必自己加",
  (await textOf(checkTool, { projectName: "归集核查样例", auxiliaryLedger: [], financialLedger: [], documents: [] })).includes(
    "合计差异",
  ),
);
const simpleChk = {
  projectName: "归集核查样例",
  auxiliaryLedger: [{ category: "personnel", amountYuan: "500000.00" }],
  financialLedger: [{ category: "personnel", amountYuan: "460000.00" }],
  documents: [],
};
const chkTrace = traceAmounts(await textOf(checkTool, simpleChk), [await detailsOf(checkTool, simpleChk)], "", []);
expect("核查正文金额全部可溯源", chkTrace.untraced.map((u) => u.raw), []);
ok("核查正文确实扫到了金额", chkTrace.total >= 3, `total=${chkTrace.total}`);

console.log(`[verify] 智研税审工具检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 智研税审业务工具规则不符");
  process.exit(1);
}
console.log("[PASS] 智研税审业务工具正确（加计扣除测算与双口径对照 / 归集核查 / 正文金额可溯源）");
