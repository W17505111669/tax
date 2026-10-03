/**
 * 交付 MD 的「结论金额溯源」节。
 *
 * 与 `delivery-docref.ts` 同一套路：这一节此前写在 TaskWorkbench 的 `bundleLines()` 里，是组件内
 * 闭包，任何单测都碰不到它——待确认金额表的列数、超出上限有没有如实说明、两类拆分有没有写进去，
 * 全靠下载下来肉眼扫。搬进模块才能喂数据跑断言（verify:delivamount）。
 */
import {
  amountKey,
  UNTRACED_ORIGIN_TEXT,
  type Amount,
  type UntracedOrigin,
  type UntracedSplit,
} from "./amount-trace.ts";
import { mdCell } from "./run-tools.ts";
import { dateTimeStamp } from "./time-format.ts";

/** 待确认金额表最多列多少条；超出要在正文里如实说明还有几处没列，不静默截断 */
export const AMOUNT_TABLE_LIMIT = 20;

/**
 * 两类的处置建议。与 `UNTRACED_ORIGIN_HINT`（解释依据是什么）分工不同：这里写的是**该做什么**，
 * 而且要短——它进的是表格的一列，写成一整段话表就没法看了。
 */
export const ORIGIN_ADVICE: Record<UntracedOrigin, string> = {
  web: "核对引用抄得准不准（数字摘自联网抓到的正文）",
  unexplained: "逐条确认是否为推算值（工具结果、客户指令与联网正文都找不到）",
};

export interface AmountSectionInput {
  /** 结论里识别出的金额总数 */
  total: number;
  /** 工具结果可溯源的处数 */
  traced: number;
  /** 来自客户指令的处数 */
  fromInput: number;
  /** 待人工确认的金额（已扣掉标记为已核对的） */
  pending: Amount[];
  /** 待确认金额的两类拆分，口径见 amount-trace.ts 的 classifyUntraced */
  split: UntracedSplit;
  /** 已人工核对的处数 */
  ackedCount: number;
  /** 已人工核对的清单 */
  acked: Array<{ raw: string; occurrences: number; at: string; note: string }>;
}

/** 交付 MD「结论金额溯源」一节的行（末尾自带一个空行收尾） */
export function amountSection(input: AmountSectionInput): string[] {
  const { total, traced, fromInput, pending, split, ackedCount, acked } = input;
  const origin = new Map<string, UntracedOrigin>();
  for (const a of split.web) origin.set(amountKey(a), "web");
  for (const a of split.unexplained) origin.set(amountKey(a), "unexplained");
  // 查不到时按更严的那一类兜底：宁可多拦一条，不能默认成轻的那类
  const originOf = (a: Amount): UntracedOrigin => origin.get(amountKey(a)) ?? "unexplained";
  return [
    "## 结论金额溯源",
    "",
    `- 结论中识别出金额 ${total} 处：工具结果可溯源 ${traced} 处 · 来自客户指令 ${fromInput} 处 · 待人工确认 ${
      pending.length
    } 处${ackedCount > 0 ? ` · 已人工核对 ${ackedCount} 处` : ""}${
      pending.length > 0
        ? `（其中引自联网正文 ${split.web.length} 处、三处均无出处 ${split.unexplained.length} 处）`
        : ""
    }`,
    ...(pending.length > 0
      ? [
          "",
          "| # | 金额 | 结论中的上下文 | 类别 | 处理建议 |",
          "| --- | --- | --- | --- | --- |",
          ...pending.slice(0, AMOUNT_TABLE_LIMIT).map((u, i) => {
            const o = originOf(u);
            return `| ${i + 1} | ${mdCell(u.raw)} | ${mdCell(u.context)} | ${UNTRACED_ORIGIN_TEXT[o]} | ${ORIGIN_ADVICE[o]} |`;
          }),
          // 超出上限要如实说明，不静默截断：交付 MD 是签字归档件，少列几处就等于少几处待办
          ...(pending.length > AMOUNT_TABLE_LIMIT
            ? [`（另有 ${pending.length - AMOUNT_TABLE_LIMIT} 处待人工确认的金额未列出）`, ""]
            : []),
          // 两类拆分要能被复核人自己对上账：分类加起来必须等于待确认总数
          `- 两类之和 ${split.web.length + split.unexplained.length} 处 = 待人工确认 ${
            pending.length
          } 处。「引自联网正文」多半是摘引政策原文或案例里的数字，溯源池按既定口径不收联网正文（否则任何金额都能声称有出处），要核对的是引用抄得准不准；「三处均无出处」是工具结果、客户指令与联网正文都找不到，这才是「模型可能口算」要拦的那一类，混在一个数里时它会被检索类任务的大批量引文淹掉。`,
        ]
      : [
          "",
          "（没有待人工确认的金额：结论中的金额都能在工具调用结果或客户指令中找到出处，或已完成人工核对）",
        ]),
    "",
    ...(acked.length > 0
      ? [
          "### 已人工核对",
          "",
          "| # | 金额 | 出现处数 | 核对时间 | 备注 |",
          "| --- | --- | --- | --- | --- |",
          ...acked.map(
            (a, i) =>
              `| ${i + 1} | ${mdCell(a.raw)} | ${a.occurrences} | ${dateTimeStamp(a.at)} | ${mdCell(
                a.note || "（无）",
              )} |`,
          ),
          "",
        ]
      : []),
    "",
  ];
}
