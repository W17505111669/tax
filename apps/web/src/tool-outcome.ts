/**
 * 工具调用的三态口径：成功 / 失败 / 未返回。
 *
 * `ok=1` 成功、`ok=0` 工具确实返回了错误、`ok IS NULL` 是调用行在工具发起时落了库、但 `result`
 * 与 `ended_at` 都为空——工具的结果没能写回这一行。
 *
 * 实测这 37 行的成因不是进程中断，而是 agent-runner 按**工具名**配对开始与结束事件：同名工具在
 * 上一次还没结束就再次开始时，后一次的行 id 覆盖前一次，前一行就永远停在 ok IS NULL，而结束时
 * 取到的又是另一次的行 id——结果被挂到错误的调用上。证据是事件表里 tool_start 与 tool_end 各
 * 270 条一一成对，说明每次调用都收到了结束事件，只是没配对上。配对已改为按 SDK 的 toolCallId，
 * 存量数据由 `pnpm repair:toolcalls` 按「结果回显入参」的硬证据恢复。
 *
 * 任务往往在后续某一轮跑完了，所以任务状态上看不出异常，只有平台指标还带着这批行；也正因如此，
 * 把它们算成「失败」一直没被发现。
 *
 * 第三态此前在平台看板上被 `总数 - 成功数` 一律算成「失败」：实测 37 次全属这一类，且集中在
 * 联网类慢工具上（get_search_content 15 · fetch_public_document 9 · search_public_cases 6）。
 * 把「没有结果」记成「结果是错误」会同时错两件事——成功率被低估（86.3% 对 100%），以及看板上
 * 那句「失败 37」会让人去查一个根本不存在的工具报错。任务页的 `callStats` 早就把 `ok === null`
 * 单列为未返回，平台侧没接上，这里是把同一个判据收成一份共用口径。
 *
 * 成功率的分母只取**有返回结果**的调用（成功 + 失败）：没有结果的调用既不进分子也不进分母，
 * 未完成次数单独摆出来给人看，不藏进比率里，也不拿它去把成功率做高。
 */

import { percentFrom, percentOf } from "./format.ts";

export interface ToolOutcomeCounts {
  /** 调用行总数 */
  calls: number;
  /** ok=1 */
  ok: number;
  /** ok=0：工具返回了错误 */
  failed: number;
  /** ok IS NULL：调用行没有结果落库（结束事件未配对回该行，或进程在工具返回前结束） */
  unfinished: number;
}

/**
 * 平台与单作品的工具调用三态计数 → 共用口径的入参形状。
 * 原本写在 AgentOverview 里，但门禁脚本（scan:uimd 核对看板 KPI 卡）也要按同一份口径算期望值，
 * 放在组件里就只能再抄一遍——四个字段名抄错一个，成功率的分母就悄悄换了。
 */
export function outcomeOf(s: {
  toolCalls: number;
  toolOk: number;
  toolFailed: number;
  toolUnfinished: number;
}): ToolOutcomeCounts {
  return { calls: s.toolCalls, ok: s.toolOk, failed: s.toolFailed, unfinished: s.toolUnfinished };
}

/** 有返回结果的调用数，也就是成功率的分母 */
export function resolvedCalls(c: ToolOutcomeCounts): number {
  return c.ok + c.failed;
}

/**
 * 成功率（百分比，两位小数）。分母是有返回结果的调用数，不是调用总数。
 * 一次有结果的调用都没有时返回 null（`percentOf` 的既有语义）——这种情况既不该显示 0%
 * （没有失败）也不该显示 100%（没有成功），由调用方用 `percentFrom` 如实显示「—」。
 */
export function successRate(c: ToolOutcomeCounts): number | null {
  return percentOf(c.ok, resolvedCalls(c));
}

/**
 * 三态是否自洽：总数必须恰好等于三态之和。
 * 不相等说明库里出现了第四种 `ok` 取值（或统计漏了一类），此时比率不可信，要如实报错而不是照算。
 */
export function countsAreConsistent(c: ToolOutcomeCounts): boolean {
  return c.calls === c.ok + c.failed + c.unfinished;
}

export type RingSegmentKey = "ok" | "failed" | "unfinished";

export interface RingSegment {
  key: RingSegmentKey;
  /** 弧长，按 calls 分配 */
  length: number;
  /** 直接传给 strokeDashoffset 的值（SVG 里是负方向），第一段为 0 */
  offset: number;
}

/**
 * 环图三段弧：按调用总数分配，顺序为 成功 → 失败 → 无结果。
 * 无结果那段用中性色而不是失败的红——它不是错误，颜色也不该替它认错。
 * calls 为 0 时返回三段长度全 0，调用方不必再挡除零。
 */
export function ringSegments(c: ToolOutcomeCounts, circumference: number): RingSegment[] {
  const total = c.calls > 0 ? c.calls : 1;
  const okLen = (c.ok / total) * circumference;
  const failedLen = (c.failed / total) * circumference;
  const unfinishedLen = (c.unfinished / total) * circumference;
  return [
    { key: "ok", length: okLen, offset: 0 },
    { key: "failed", length: failedLen, offset: -okLen },
    { key: "unfinished", length: unfinishedLen, offset: -(okLen + failedLen) },
  ];
}

/** 一行文字说清三态，导出 MD / TSV / 快照共用，避免各处各写一句话口径不一致 */
export function outcomeLine(c: ToolOutcomeCounts): string {
  const rate = successRate(c);
  // 走 percentFrom：这里此前自己拼 `${rate}%`，等于「数值 → 百分比文案」在 format.ts 之外又存了一份
  const rateText = percentFrom(rate);
  const base = `工具调用 ${c.calls} 次 · 成功 ${c.ok} · 失败 ${c.failed} · 成功率 ${rateText}（分母为有返回结果的 ${resolvedCalls(c)} 次）`;
  return c.unfinished > 0
    ? `${base} · 另有 ${c.unfinished} 次调用没有结果落库（结束事件未配对回该行，或进程在工具返回前结束；不计入成功率分子分母）`
    : base;
}
