/**
 * 引用链接核验结果的分级：把「反爬拒绝」与「链接真的失效」分开，
 * 否则百科/知乎一类站点对服务端 GET 返回 403 时，会把好链接报成死链。
 * 纯函数，便于 apps/api/scripts/verify-link-check.ts 直接校验。
 */

import { relTime } from "./time-format.ts";

export type LinkVerdict = "ok" | "blocked" | "dead" | "unreachable";

export type LinkCheckLike = { ok: boolean; status: number | null; error?: string };

export const VERDICT_TEXT: Record<LinkVerdict, string> = {
  ok: "可访问",
  blocked: "拒绝自动访问",
  dead: "链接失效",
  unreachable: "无法核验",
};

export const VERDICT_HINT: Record<LinkVerdict, string> = {
  ok: "服务端 GET 返回 2xx/3xx",
  blocked: "站点返回 401/403/405/429，多为反爬或需登录；链接对人可能仍然有效，请人工点击确认",
  dead: "站点返回 4xx（404/410 等），链接大概率已失效，交付前请替换或补充依据",
  unreachable: "网络错误、超时、5xx 或被安全策略拦截，无法判定，请稍后重试或人工确认",
};

/** 单条核验结果的分级判定 */
export function linkVerdict(c: LinkCheckLike): LinkVerdict {
  const s = c.status;
  if (s === null || s === undefined) return "unreachable";
  if (s < 400) return "ok";
  if (s === 401 || s === 403 || s === 405 || s === 429) return "blocked";
  if (s >= 500) return "unreachable";
  return "dead";
}

export type LinkSummary = { total: number; ok: number; blocked: number; dead: number; unreachable: number };

/** 批量核验结果的汇总（交付自检与界面计数共用同一口径） */
export function summarizeLinkChecks(list: LinkCheckLike[]): LinkSummary {
  const out: LinkSummary = { total: list.length, ok: 0, blocked: 0, dead: 0, unreachable: 0 };
  for (const c of list) out[linkVerdict(c)] += 1;
  return out;
}

/** 核验时效阈值：超过 72 小时视为过期，交付前建议重新核验 */
export const STALE_HOURS = 72;

/** 距今小时数；时间缺失、不可解析或晚于当前时间都返回 null，不编造数字 */
export function ageHours(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t) || t > now) return null;
  return (now - t) / 3_600_000;
}

export type Freshness = "fresh" | "stale" | "unknown";

/** 核验结果的新鲜度：用于决定要不要提示重新核验 */
export function freshness(
  iso: string | null | undefined,
  now: number = Date.now(),
  thresholdHours: number = STALE_HOURS,
): Freshness {
  const h = ageHours(iso, now);
  if (h === null) return "unknown";
  return h > thresholdHours ? "stale" : "fresh";
}

/** 人类可读的「多久以前」 */
export function ageText(iso: string | null | undefined, now: number = Date.now()): string {
  const h = ageHours(iso, now);
  if (h === null) return "";
  // 分档口径统一走 time-format.ts；这里只保留「没有核验时间 / 时间在未来」返回空串的语义
  return relTime(iso, now, "");
}
