/**
 * 看板 hero 区那几个数（近 14 天日桶、日均、运行天数、较上周）的口径：一份实现，
 * AgentOverview 渲染与 scan:uimd 算期望值共用。
 *
 * 此前这段写在组件的 useMemo 里，门禁要核对就只能再抄一遍——日桶是按**本地日**切的，
 * 抄的时候差一个时区或者把 14 写成 15，「今日 N 件」就会悄悄差一天，而界面上看不出来。
 */
export const TREND_DAYS = 14;

/** 近 14 天的日桶（按本地日切），下标 TREND_DAYS-1 是今天；早于 14 天的不计入 */
export function dayBuckets(createdAts: string[], now: Date = new Date()): number[] {
  const buckets = Array.from({ length: TREND_DAYS }, () => 0);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  for (const c of createdAts) {
    const d = new Date(c);
    const diff = Math.floor((today - Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (diff >= 0 && diff < TREND_DAYS) buckets[TREND_DAYS - 1 - diff] = (buckets[TREND_DAYS - 1 - diff] ?? 0) + 1;
  }
  return buckets;
}

/** 日均：14 天合计 / 14。分母固定是窗口天数，不按「有任务的那几天」缩水，否则空窗越多日均越好看 */
export function dayAvgOf(buckets: number[]): number {
  return buckets.reduce((a, b) => a + b, 0) / TREND_DAYS;
}

/** 运行天数：第一条任务到现在，含首尾两天；一条都没有就是 0（不显示这个徽章） */
export function runDaysOf(createdAts: string[], now: Date = new Date()): number {
  if (createdAts.length === 0) return 0;
  const first = Math.min(...createdAts.map((c) => Date.parse(c)));
  return Math.floor((now.getTime() - first) / 86400000) + 1;
}

/**
 * 周环比：窗口后 7 天合计对前 7 天合计（不是自然周，是滚动 7 天对 7 天）。
 * now / prev 也一起返回：界面上那两条对比条与导出文本都要用到这两个数，
 * 只返回 delta 的话它们就得自己再切一次数组，切法一不一致环比就对不上。
 */
export function weekHalves(buckets: number[]): { now: number; prev: number; delta: number } {
  const half = TREND_DAYS / 2;
  const now = buckets.slice(half).reduce((a, b) => a + b, 0);
  const prev = buckets.slice(0, half).reduce((a, b) => a + b, 0);
  return { now, prev, delta: now - prev };
}

/**
 * sparkline 的纵轴映射：viewBox 高 30，绘图区从 y=SPARK_BASE 往上画 SPARK_SPAN 高。
 * 这条公式此前在组件里写了三遍（折线点位一次、日均虚线的 y1 / y2 各一次），28 与 24 两个魔数
 * 也散在三处；改一处忘两处，折线与日均线就会不再同一个尺度——图上看着「差不多」，其实差一截，
 * 而这种偏差没有任何文字数字可供核对，只能靠把映射收成一份来杜绝。
 */
export const SPARK_BASE = 28;
export const SPARK_SPAN = 24;

/** 纵轴分母：至少为 1，否则全 0 的窗口会除零得到 NaN，整条折线消失 */
export function dayMaxOf(buckets: number[]): number {
  return Math.max(1, ...buckets);
}

/** 一个日桶值在 sparkline 上的 y 坐标 */
export function sparkY(v: number, dayMax: number): number {
  return SPARK_BASE - (v / dayMax) * SPARK_SPAN;
}

/** 折线点位串（与 <polyline points> 直接对得上，也是门禁核对的期望值） */
export function sparkPoints(buckets: number[]): string {
  const max = dayMaxOf(buckets);
  return buckets
    .map((v, i) => `${((i / (TREND_DAYS - 1)) * 100).toFixed(2)},${sparkY(v, max).toFixed(2)}`)
    .join(" ");
}
