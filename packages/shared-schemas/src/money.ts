/**
 * 金额处理统一使用「整数分」，避免 JavaScript 浮点累加误差。
 * 交接文档 7.2 明确要求：关键财务数据不得用普通浮点数直接累加。
 */

const AMOUNT_RE = /^(-?)(\d{1,15})(?:\.(\d{1,2}))?\d*$/;

/** 把「元」的字符串或数字精确转换为「分」的整数。 */
export function yuanToCents(value: string | number): number {
  const raw = String(value).trim().replace(/[,，\s¥￥]/g, "");
  if (raw === "") return 0;
  const m = AMOUNT_RE.exec(raw);
  if (!m) throw new Error(`无法解析金额: ${value}`);
  const sign = m[1] === "-" ? -1 : 1;
  const integerPart = Number(m[2]);
  const fractionPart = Number((m[3] ?? "").padEnd(2, "0"));
  return sign * (integerPart * 100 + fractionPart);
}

/** 把「分」格式化为「元」字符串，固定两位小数。 */
export function centsToYuan(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function sumCents(values: number[]): number {
  let total = 0;
  for (const v of values) total += Math.round(v);
  return total;
}

/** 向下取整的整数分乘法，用于比例计算（如 10% 限额、100% 加计）。 */
export function multiplyCents(cents: number, numerator: number, denominator: number): number {
  return Math.floor((Math.round(cents) * numerator) / denominator);
}
