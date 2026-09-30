import { Type } from "typebox";
import { centsToYuan, multiplyCents, sumCents, yuanToCents } from "@tax/shared-schemas";
import type { ToolDefinition } from "@tax/agent-core";

export const RD_CATEGORIES = [
  "personnel",
  "direct",
  "depreciation",
  "intangible",
  "design",
  "other",
] as const;

export const RD_CATEGORY_LABELS: Record<(typeof RD_CATEGORIES)[number], string> = {
  personnel: "人员人工费用",
  direct: "直接投入费用",
  depreciation: "折旧费用",
  intangible: "无形资产摊销",
  design: "新产品设计费等",
  other: "其他相关费用",
};

const CategorySchema = Type.String({
  pattern: `^(${RD_CATEGORIES.join("|")})$`,
  description:
    "费用类别。personnel=人员人工费用, direct=直接投入费用, depreciation=折旧费用, intangible=无形资产摊销, design=新产品设计费等, other=其他相关费用",
});

const ExpenseItemSchema = Type.Object({
  category: CategorySchema,
  amountYuan: Type.String({ description: "金额（元），字符串形式，例如 \"120000.00\"" }),
});

interface ExpenseItem {
  category: (typeof RD_CATEGORIES)[number];
  amountYuan: string;
}

function groupByCategory(items: ExpenseItem[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of RD_CATEGORIES) map.set(c, 0);
  for (const item of items) {
    map.set(item.category, (map.get(item.category) ?? 0) + yuanToCents(item.amountYuan));
  }
  return map;
}

/** 单个口径的测算中间量。全程整数分，出口再统一转元，避免浮点误差。 */
interface RdScenarioCents {
  grouped: Map<string, number>;
  base5: number;
  otherActual: number;
  otherLimit: number;
  otherAllowed: number;
  otherExceeded: number;
  deductibleBase: number;
  deduction: number;
}

function computeRdScenarioCents(expenses: ExpenseItem[], deductionRatePercent: number): RdScenarioCents {
  const grouped = groupByCategory(expenses);
  const firstFive = RD_CATEGORIES.filter((c) => c !== "other");
  const base5 = sumCents(firstFive.map((c) => grouped.get(c) ?? 0));
  const otherActual = grouped.get("other") ?? 0;
  const otherLimit = multiplyCents(base5, 10, 90);
  const otherAllowed = Math.min(otherActual, otherLimit);
  const otherExceeded = otherActual - otherAllowed;
  const deductibleBase = base5 + otherAllowed;
  const deduction = multiplyCents(deductibleBase, deductionRatePercent, 100);
  return { grouped, base5, otherActual, otherLimit, otherAllowed, otherExceeded, deductibleBase, deduction };
}

/** 一个口径的完整测算结果（元字符串）。既是工具主输出，也是双口径对照表的一列。 */
function rdScenarioDetails(label: string, s: RdScenarioCents, deductionRatePercent: number) {
  return {
    label,
    deductionRatePercent,
    byCategory: RD_CATEGORIES.map((c) => ({
      category: c,
      label: RD_CATEGORY_LABELS[c],
      amountYuan: centsToYuan(s.grouped.get(c) ?? 0),
    })),
    firstFiveTotalYuan: centsToYuan(s.base5),
    otherActualYuan: centsToYuan(s.otherActual),
    otherLimitYuan: centsToYuan(s.otherLimit),
    otherAllowedYuan: centsToYuan(s.otherAllowed),
    otherExceededYuan: centsToYuan(s.otherExceeded),
    deductibleBaseYuan: centsToYuan(s.deductibleBase),
    deductionYuan: centsToYuan(s.deduction),
  };
}

type RdScenarioDetails = ReturnType<typeof rdScenarioDetails>;

/** 对照表逐行口径：行名 + 两个口径的值 + 差额，差额一律由程序相减。 */
const COMPARISON_ROWS: Array<{ key: keyof Omit<RdScenarioDetails, "label" | "deductionRatePercent" | "byCategory">; row: string }> = [
  { key: "firstFiveTotalYuan", row: "前五类费用合计" },
  { key: "otherActualYuan", row: "其他相关费用实际发生" },
  { key: "otherLimitYuan", row: "其他相关费用限额" },
  { key: "otherAllowedYuan", row: "可加计的其他相关费用" },
  { key: "otherExceededYuan", row: "超限额部分（不得加计）" },
  { key: "deductibleBaseYuan", row: "可加计扣除基数" },
  { key: "deductionYuan", row: "加计扣除额" },
];

/**
 * 研发费用加计扣除确定性测算。
 * 规则：其他相关费用限额 = 前五类费用之和 × 10% / (1 - 10%)。
 * 全程使用整数分计算，避免浮点误差。
 */
export const calculateRdAdjustmentTool: ToolDefinition = {
  name: "calculate_rd_adjustment",
  label: "研发费用加计扣除测算",
  description:
    "按确定性规则测算研发费用加计扣除金额。输入研发项目、费用年度、六大类归集金额与加计扣除比例，输出其他相关费用限额、超限金额、可加计扣除基数与加计扣除额。需要比较两个归集口径（如辅助账口径与财务明细账口径）时，用 alternative 传入第二个口径，工具会同时输出两口径对照表与逐项差额；不要自行把两次测算结果相减。涉及金额必须调用本工具。",
  promptSnippet:
    "calculate_rd_adjustment: 测算研发费用加计扣除额与其他相关费用限额；传 alternative 可一次得到两口径对照与差额",
  parameters: Type.Object({
    projectName: Type.String(),
    year: Type.Integer({ minimum: 2008, maximum: 2100 }),
    expenses: Type.Array(ExpenseItemSchema, { minItems: 1 }),
    deductionRatePercent: Type.Integer({
      minimum: 0,
      maximum: 200,
      description: "加计扣除比例，一般企业为 100，集成电路和工业母机企业为 120",
    }),
    label: Type.Optional(Type.String({ description: "主口径名称，如「辅助账口径」，缺省为「主口径」" })),
    alternative: Type.Optional(
      Type.Object({
        label: Type.String({ description: "对照口径名称，如「财务明细账口径」" }),
        expenses: Type.Array(ExpenseItemSchema, {
          minItems: 1,
          description: "对照口径的六大类归集金额，与主口径同一年度、同一比例",
        }),
      }),
    ),
  }),
  async execute(_toolCallId, params: {
    projectName: string;
    year: number;
    expenses: ExpenseItem[];
    deductionRatePercent: number;
    label?: string;
    alternative?: { label: string; expenses: ExpenseItem[] };
  }) {
    const primaryLabel = params.label?.trim() || "主口径";
    const primary = computeRdScenarioCents(params.expenses, params.deductionRatePercent);
    const primaryDetails = rdScenarioDetails(primaryLabel, primary, params.deductionRatePercent);

    // 对照口径只在调用方明确要求时才算，差额一律由程序相减。结论里不该再出现手算的减法：
    // 实测 17a56468 的「财务明细账口径前五类 2,040,000.00 / 限额 226,666.66 / 两口径差额
    // 454,444.45」三个数都是模型自己算的，工具结果里找不到出处，被金额溯源判为待人工确认。
    const altLabel = params.alternative?.label.trim() || "对照口径";
    const altCents = params.alternative
      ? computeRdScenarioCents(params.alternative.expenses, params.deductionRatePercent)
      : null;
    const altDetails = altCents ? rdScenarioDetails(altLabel, altCents, params.deductionRatePercent) : null;
    const delta: Record<string, string> | null = altDetails
      ? Object.fromEntries(
          COMPARISON_ROWS.map(({ key }) => [
            key,
            centsToYuan(yuanToCents(altDetails[key]) - yuanToCents(primaryDetails[key])),
          ]),
        )
      : null;

    const details = {
      ...primaryDetails,
      projectName: params.projectName,
      year: params.year,
      limitRule: "其他相关费用限额 = 前五类费用之和 × 10% ÷ (1 - 10%)",
      amountUnit: "元（内部按整数分计算）",
      ...(altDetails && delta
        ? {
            comparison: {
              primary: primaryDetails,
              alternative: altDetails,
              deltaLabel: `${altLabel} - ${primaryLabel}`,
              delta,
            },
          }
        : {}),
    };

    const lines = [
      `项目「${params.projectName}」${params.year} 年度研发费用加计扣除测算结果：`,
      ...primaryDetails.byCategory.map((c) => `- ${c.label}: ${c.amountYuan} 元`),
      `- 前五类合计: ${details.firstFiveTotalYuan} 元`,
      `- 其他相关费用实际发生: ${details.otherActualYuan} 元`,
      `- 其他相关费用限额: ${details.otherLimitYuan} 元`,
      `- 超限额部分（不得加计）: ${details.otherExceededYuan} 元`,
      `- 可加计扣除基数: ${details.deductibleBaseYuan} 元`,
      `- 加计扣除比例: ${params.deductionRatePercent}%`,
      `- 加计扣除额: ${details.deductionYuan} 元`,
    ];

    if (altDetails && delta) {
      // 对照表直接进正文，模型可以整段照抄，不必自己把两个口径的数拼起来
      lines.push(
        "",
        `两口径对照（差额 = ${altLabel} - ${primaryLabel}，由工具计算）：`,
        `| 项目 | ${primaryLabel} | ${altLabel} | 差额 |`,
        "|---|---|---|---|",
        ...COMPARISON_ROWS.map(
          ({ key, row }) => `| ${row} | ${primaryDetails[key]} | ${altDetails[key]} | ${delta[key]} |`,
        ),
      );
    }

    return { content: [{ type: "text", text: lines.join("\n") }], details };
  },
};

interface LedgerItem extends ExpenseItem {}
interface DocItem {
  name: string;
  provided: boolean;
}

/**
 * 研发费用归集规则核查：比对辅助账与财务明细账，识别差异、缺失资料与异常金额。
 */
export const checkRdExpensesTool: ToolDefinition = {
  name: "check_rd_expenses",
  label: "研发费用归集核查",
  description:
    "核查研发费用归集情况。输入研发支出辅助账、财务明细账与资料清单，输出按类别的金额比对、差异清单、缺失资料清单与待复核事项。用于发现重复归集、遗漏归集与账账不符。",
  promptSnippet: "check_rd_expenses: 比对辅助账与财务明细账，输出差异与缺失清单",
  parameters: Type.Object({
    projectName: Type.String(),
    auxiliaryLedger: Type.Array(ExpenseItemSchema, { description: "研发支出辅助账" }),
    financialLedger: Type.Array(ExpenseItemSchema, { description: "财务明细账（研发支出科目）" }),
    documents: Type.Array(
      Type.Object({ name: Type.String(), provided: Type.Boolean() }),
      { description: "留存备查资料清单及是否已取得" },
    ),
  }),
  async execute(_toolCallId, params: {
    projectName: string;
    auxiliaryLedger: ExpenseItem[];
    financialLedger: LedgerItem[];
    documents: DocItem[];
  }) {
    const aux = groupByCategory(params.auxiliaryLedger);
    const fin = groupByCategory(params.financialLedger);

    const issues: Array<{
      issueType: string;
      description: string;
      evidence: string[];
      requiresReview: boolean;
    }> = [];

    const comparison = RD_CATEGORIES.map((c) => {
      const auxCents = aux.get(c) ?? 0;
      const finCents = fin.get(c) ?? 0;
      const diffCents = auxCents - finCents;
      const label = RD_CATEGORY_LABELS[c];
      if (diffCents !== 0) {
        issues.push({
          issueType: "账账差异",
          description: `「${label}」辅助账 ${centsToYuan(auxCents)} 元，财务明细账 ${centsToYuan(finCents)} 元，差异 ${centsToYuan(diffCents)} 元。`,
          evidence: [`category:${c}`, "auxiliaryLedger", "financialLedger"],
          requiresReview: true,
        });
      }
      if (auxCents < 0 || finCents < 0) {
        issues.push({
          issueType: "异常金额",
          description: `「${label}」存在负数金额，需核实是否为冲销或红字凭证。`,
          evidence: [`category:${c}`],
          requiresReview: true,
        });
      }
      if (auxCents === 0 && finCents > 0) {
        issues.push({
          issueType: "辅助账遗漏",
          description: `「${label}」财务明细账有 ${centsToYuan(finCents)} 元，但辅助账未归集，可能存在遗漏。`,
          evidence: [`category:${c}`, "financialLedger"],
          requiresReview: true,
        });
      }
      return {
        category: c,
        label,
        auxiliaryYuan: centsToYuan(auxCents),
        financialYuan: centsToYuan(finCents),
        differenceYuan: centsToYuan(diffCents),
        consistent: diffCents === 0,
      };
    });

    for (const doc of params.documents) {
      if (!doc.provided) {
        issues.push({
          issueType: "资料缺失",
          description: `留存备查资料「${doc.name}」尚未取得。`,
          evidence: [`document:${doc.name}`],
          requiresReview: true,
        });
      }
    }

    const auxTotal = sumCents(RD_CATEGORIES.map((c) => aux.get(c) ?? 0));
    const finTotal = sumCents(RD_CATEGORIES.map((c) => fin.get(c) ?? 0));

    const details = {
      projectName: params.projectName,
      comparison,
      auxiliaryTotalYuan: centsToYuan(auxTotal),
      financialTotalYuan: centsToYuan(finTotal),
      totalDifferenceYuan: centsToYuan(auxTotal - finTotal),
      issues,
      issueCount: issues.length,
    };

    const text = [
      `项目「${params.projectName}」研发费用归集核查结果：`,
      `- 辅助账合计: ${details.auxiliaryTotalYuan} 元`,
      `- 财务明细账合计: ${details.financialTotalYuan} 元`,
      `- 合计差异: ${details.totalDifferenceYuan} 元`,
      `- 发现问题 ${issues.length} 项`,
      ...issues.map((i, idx) => `  ${idx + 1}. [${i.issueType}] ${i.description}`),
    ].join("\n");

    return { content: [{ type: "text", text }], details };
  },
};

export const rdTools = [calculateRdAdjustmentTool, checkRdExpensesTool];
