/**
 * 指标趋势：每日快照、基线选择与环比差值。
 *
 * 看板上的「较 7 天前」原本内联在组件里、只覆盖任务数等三个指标，证据类指标接不进去，
 * 也没法验证。这里抽成纯函数：快照的记录与裁剪、基线日选择（优先正好 7 天前，
 * 否则取该日之前最近的一次）、差值计算与「越大越好 / 越小越好」的方向判断。
 * 存储仍由调用方负责（localStorage），本模块不碰浏览器 API。
 */

export type DailySnapshot = Record<string, Record<string, number>>;

/** 按天回退：用 UTC 计算，避免本地时区把日期算偏一天 */
export function shiftDay(day: string, backDays: number): string | null {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t - backDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 记录当天快照并裁剪历史：同一天重复打开只保留最新值，
 * 只保留最近 keepDays 天（按日期字符串排序即可，ISO 格式天然可比）。
 */
export function recordSnapshot(
  snap: DailySnapshot,
  day: string,
  values: Record<string, number>,
  keepDays = 60,
): DailySnapshot {
  const next: DailySnapshot = { ...snap, [day]: { ...(snap[day] ?? {}), ...values } };
  const keys = Object.keys(next).sort();
  if (keys.length > keepDays) for (const k of keys.slice(0, keys.length - keepDays)) delete next[k];
  return next;
}

/** 基线日：优先正好 backDays 天前那天，否则取该日（含）之前最近的一次快照；都没有则 null */
export function baselineKey(snap: DailySnapshot, day: string, backDays = 7): string | null {
  const target = shiftDay(day, backDays);
  if (target === null) return null;
  if (snap[target]) return target;
  const earlier = Object.keys(snap)
    .filter((k) => k <= target)
    .sort();
  return earlier.length > 0 ? (earlier[earlier.length - 1] ?? null) : null;
}

/**
 * 环比差值：只算基线里也有的指标（老快照没有证据类字段时不会算出假的巨大差值）。
 * 返回的键顺序与 keys 一致，缺基线的键不出现在结果里。
 */
export function deltas(
  current: Record<string, number>,
  baseline: Record<string, number> | undefined,
  keys: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!baseline) return out;
  for (const k of keys) {
    const b = baseline[k];
    const c = current[k];
    if (typeof b === "number" && typeof c === "number") out[k] = c - b;
  }
  return out;
}

export type TrendDirection = "better" | "worse" | "flat" | "unknown";

/** 方向判断：lowerIsBetter 为真时下降算改善（弱证据引用、待复查文号属于这类） */
export function trend(value: number | undefined, lowerIsBetter: boolean): TrendDirection {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  if (value === 0) return "flat";
  const down = value < 0;
  return (down && lowerIsBetter) || (!down && !lowerIsBetter) ? "better" : "worse";
}

/** 趋势文本：▲/▼ 加绝对值；无基线或持平时返回空串（界面据此不渲染） */
export function trendText(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return "";
  return value > 0 ? `▲${value}` : `▼${Math.abs(value)}`;
}

/** 提示文案：说明基线是哪一天、指标是越大越好还是越小越好 */
export function trendTitle(baseDay: string | null, lowerIsBetter: boolean): string {
  const when = baseDay ? `较 ${baseDay} 快照` : "暂无历史快照";
  return `${when}（${lowerIsBetter ? "越低越好" : "越高越好"}）`;
}
