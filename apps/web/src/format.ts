/**
 * 数字与单位的排版口径。
 *
 * 同一页上曾同时出现「50 %」与「60%」、「94.64%」与「94.6%」、「25.00 MB」与「—%」，
 * 都是各处自己 toFixed / Math.round 的结果。这里把三件事收成一处：
 * 百分比的取值与小数位、字节数去掉多余的零、数字与单位之间要不要留空隙。
 *
 * 纯函数，便于 apps/api/scripts/verify-format.ts 直接校验。
 */

/** 去掉小数末尾多余的零：25.00 → 25、1.20 → 1.2；整数不动（100 不会被削成 1） */
export function trimZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * 百分比取值：分母为 0 或不是有限数时如实返回 null，由调用方显示「—」。
 * 不返回 0——「成功率 0%」和「没有调用」是两件事，混为一谈就是造假。
 */
export function percentOf(part: number, total: number, digits = 2): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0 || part < 0) return null;
  const f = 10 ** Math.max(0, Math.trunc(digits));
  return Math.round((part / total) * 100 * f) / f;
}

/** 百分比数值文案（不带 %）：算不出来给「—」，供把数值与单位分开渲染的卡片用 */
export function percentValue(part: number, total: number, digits = 2): string {
  const v = percentOf(part, total, digits);
  return v === null ? "—" : String(v);
}

/** 百分比完整文案：94.64%；算不出来给「—」，不会写成「—%」 */
export function percentText(part: number, total: number, digits = 2): string {
  const v = percentOf(part, total, digits);
  return v === null ? "—" : `${v}%`;
}

/** 已经算好的百分比数值转文案：null / undefined / 非有限数一律「—」 */
export function percentFrom(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${trimZeros(String(value))}%` : "—";
}

/**
 * 数字与单位之间要不要留空隙：中文单位（个 / 份 / 次）留一格，
 * % 与 ％ 紧贴数字——「50 %」在中英文排版规范里都写作「50%」。
 */
export function needsUnitSpace(unit: string): boolean {
  const u = unit.trimStart();
  if (u === "") return false;
  return !/^[%％]/.test(u);
}

/* ===== 时长 =====
 * 三种场合三种写法，但每种只允许有一份实现：
 * 页面正文与状态条用中文（12.3 秒 / 3 分钟），时间线角标用紧凑写法（12s / 3m），
 * 导出文档与工具耗时用 SI 写法（320 ms / 3.5 s，单位前留一个空格，与 fmtBytes 一致）。
 */

/** 秒 → 中文时长：满 90 秒进位到整数分钟，否则按 digits 位小数；实时计时传 digits=0 */
export function fmtDurationZh(seconds: number, digits = 1): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  return seconds >= 90 ? `${Math.round(seconds / 60)} 分钟` : `${seconds.toFixed(digits)} 秒`;
}

/** 秒 → 紧凑角标：满 90 秒用 m，否则整数 s（角标位置太窄，单位紧贴数字） */
export function fmtDurationShort(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  return seconds >= 90 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds)}s`;
}

/** 秒 → 紧凑写法但保留小数位（tooltip 与统计行用），单位紧贴数字 */
export function fmtSecondsShort(seconds: number, digits = 1): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  return `${seconds.toFixed(digits)}s`;
}

/** 毫秒 → 文档口径：不足 1 秒用 ms，否则一位小数 s；null 与非有限数如实给「—」 */
export function fmtMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
