/**
 * 工具调用清单：按运行时间窗分组，供整页交付 MD 的「工具调用清单」一节使用。
 * 时间窗沿用 run-artifacts.ts 的 runWindows，保证同一份交付里产物归属与调用归属口径一致。
 * 纯函数，便于 apps/api/scripts/verify-run-tools.ts 直接校验。
 */
import type { RunWindow } from "./run-artifacts.ts";
import { fmtMs } from "./format.ts";

export type CallRow = {
  id: string;
  toolName: string;
  at: string;
  endedAt: string | null;
  ok: boolean | null;
  args: unknown;
};

/** Markdown 表格单元格安全化：竖线与换行会破坏表格结构 */
export function mdCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** 入参摘要：单行化 + 截断（截断处显式标注原长度），让交付清单能一眼看出调用意图 */
export function summarizeArgs(args: unknown, limit = 120): string {
  if (args === null || args === undefined) return "—";
  let s: string;
  try {
    s = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    s = String(args);
  }
  if (s === undefined) return "—";
  s = s.replace(/\s+/g, " ").trim();
  if (s.length === 0) return "—";
  if (s.length > limit) s = `${s.slice(0, limit)}…（共 ${s.length} 字符）`;
  return mdCell(s);
}

/** 耗时（毫秒）：未结束、时间不可解析或结束早于开始都返回 null，不编造数字 */
export function durationMs(at: string, endedAt: string | null): number | null {
  if (!endedAt) return null;
  const a = Date.parse(at);
  const b = Date.parse(endedAt);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return b - a;
}

/** 工具耗时：口径统一走 format.ts（SI 写法，单位前留一个空格，与字节数一致） */
export function fmtDuration(ms: number | null): string {
  return fmtMs(ms);
}

/** 按运行时间窗分组；run=0 表示落在任何运行窗口之外（例如首个 run_started 之前） */
export function callsByRun(calls: CallRow[], windows: RunWindow[]): Map<number, CallRow[]> {
  const out = new Map<number, CallRow[]>();
  for (const c of calls) {
    const w = windows.find((x) => c.at >= x.start && (x.end === null || c.at <= x.end));
    const key = w ? w.run : 0;
    const list = out.get(key);
    if (list) list.push(c);
    else out.set(key, [c]);
  }
  return out;
}

/** 调用汇总：次数、成功、失败、执行中与平均耗时（只统计有结束时间的调用） */
export function callStats(calls: CallRow[]): {
  total: number;
  ok: number;
  failed: number;
  running: number;
  avgMs: number | null;
} {
  const durations = calls.map((c) => durationMs(c.at, c.endedAt)).filter((d): d is number => d !== null);
  return {
    total: calls.length,
    ok: calls.filter((c) => c.ok === true).length,
    failed: calls.filter((c) => c.ok === false).length,
    running: calls.filter((c) => c.ok === null).length,
    avgMs: durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
  };
}
