/**
 * 时间的显示口径：相对时间（多久以前）与文件名时间戳。
 *
 * `relTime` 之前在侧栏与平台总览各有一份一模一样的实现，`link-check.ts` 的 `ageText`
 * 是第三份、分档还不同（不足 1 小时一律「刚刚」，没有分钟档）——同一件事在不同页面
 * 可能一处显示「刚刚」另一处显示「30 分钟前」。这里收成一份，兜底文案由调用方指定。
 *
 * 纯函数：`now` 可注入，验证脚本用固定时间断言，不依赖真实时钟。
 */

/**
 * 相对时间：不足 1 分钟「刚刚」，其余按分钟 / 小时 / 天分档。
 * 解析不出来一律给 fallback（不猜一个「刚刚」把坏数据藏起来）；
 * 时间在未来（本机与服务端有轻微时钟偏差）按「刚刚」处理，不显示负数。
 */
export function relTime(iso: string | null | undefined, now: number = Date.now(), fallback = "—"): string {
  if (typeof iso !== "string" || iso === "") return fallback;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return fallback;
  const m = Math.floor((now - t) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/**
 * 文件名用的时间戳：20260928155452。
 * 连字符也一并去掉——原来只删冒号与 T，会得到「2026-09-28120000」这种既不是日期
 * 也不是时间的含糊写法，排序时还会和真正的日期戳混在一起。
 */
export function fileStamp(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace(/[-:T]/g, "");
}

/** 日期戳：2026-09-28。文件名里只用到日期时用它，带连字符更好读也便于排序 */
export function dayStamp(when: Date | string = new Date()): string {
  return (typeof when === "string" ? when : when.toISOString()).slice(0, 10);
}
