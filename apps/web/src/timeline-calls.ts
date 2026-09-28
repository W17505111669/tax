/**
 * 时间线 tool_start 事件与工具调用记录的配对。
 * 导出 MD（按次运行下载 / 过滤视图导出）时要用：早先按「同名第 N 次」在子集里重新计数，
 * 一旦同名工具跨多次运行调用，第 2 次运行的导出就会挂上第 1 次的入参与返回值。
 * 纯函数，便于 apps/api/scripts/verify-timeline-calls.ts 直接校验。
 */

export type CallLike = { id: string; toolName: string };

/** 事件形态：payload 在类型上是 unknown（与 AgentEvent 一致），内部按工具事件结构解读 */
export type ItemLike = { kind: string; payload?: unknown };

type ToolPayload = { toolName?: string; callId?: string } | null | undefined;

/**
 * 返回与 items 等长的数组：第 i 项是第 i 条事件对应的调用记录下标，非 tool_start 或未配对为 -1。
 * 优先按 payload.callId 精确匹配；没有 callId（历史事件）或 callId 失配时，
 * 退回「同名第 N 次」，且计数始终按传入的完整 items 顺序推进。
 */
export function matchToolCalls<I extends ItemLike, C extends CallLike>(items: I[], calls: C[]): number[] {
  const byId = new Map<string, number>();
  const sameName = new Map<string, number[]>();
  calls.forEach((c, i) => {
    byId.set(c.id, i);
    const list = sameName.get(c.toolName);
    if (list) list.push(i);
    else sameName.set(c.toolName, [i]);
  });

  const counters = new Map<string, number>();
  return items.map((it) => {
    if (it.kind !== "tool_start") return -1;
    const p = it.payload as ToolPayload;
    const callId = p?.callId;
    if (callId !== undefined) {
      const exact = byId.get(callId);
      if (exact !== undefined) return exact;
    }
    const name = p?.toolName ?? "";
    const n = counters.get(name) ?? 0;
    counters.set(name, n + 1);
    const list = sameName.get(name);
    const idx = list?.[n];
    return idx === undefined ? -1 : idx;
  });
}
