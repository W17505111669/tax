/**
 * 结论金额溯源：把审查结论里出现的金额与工具调用结果里的数值对齐，
 * 找出「结论里有、工具结果里没有」的金额——本作品主张金额全部由确定性工具计算、模型零口算，
 * 这一节就是该主张的可核对证据。
 *
 * 口径说明（刻意偏保守，宁可少报也不误伤）：
 * - 只抓带单位（元/万元/￥/人民币）、带千分位分隔符、或整数部分不少于 6 位的数字
 *   （6 位这个门槛是为了排除「12366 纳税服务平台」一类的短编号）；
 * - 排除百分比、年月日、以及后面紧跟量词（份/条/项/次/个/大/年/月/日）的数字；
 * - 工具侧同时登记「元」与「分」两种量纲（工具内部按整数分计算，输出常以元呈现），
 *   因此匹配偏宽松：目的是标出真正无出处的金额，而不是制造噪音。
 * 纯函数，便于 apps/api/scripts/verify-amount-trace.ts 直接校验。
 */

export type Amount = {
  /** 归一化后的展示形式（含符号与单位，不含空格） */
  raw: string;
  /** 原文中的精确片段，用于在渲染后的正文里就地标注 */
  match: string;
  cents: number;
  index: number;
  context: string;
};

export type TraceResult = {
  /** 结论里识别出的金额总数 */
  total: number;
  /** 能在工具调用结果里找到出处的金额数 */
  traced: number;
  /** 工具结果没有、但客户指令里出现过的金额数（属于转述输入，不是模型口算） */
  fromInput: number;
  /** 两边都找不到的金额，需要人工确认 */
  untraced: Amount[];
};

/** 数字后面跟这些字符时不视为金额（量词、日期、百分比） */
const REJECT_SUFFIX = /^[%％年月日份条项次个大类人天]/;

const AMOUNT_RE = /([+\-−])?\s*(￥|¥)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(万元|元|人民币)?/g;

/** 紧邻这些字符时说明数字是 URL / 文件名 / 编号的一部分，不当作金额 */
const TOKEN_BEFORE = /[A-Za-z0-9/.\-_#:=?&%]/;

function toCents(value: string, unit: string | undefined): number | null {
  const n = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const yuan = unit === "万元" ? n * 10000 : n;
  return Math.round(yuan * 100);
}

/** 从结论文本中提取金额（返回分为单位的整数值与上下文片段） */
export function extractAmounts(text: string): Amount[] {
  const out: Amount[] = [];
  if (!text) return out;
  AMOUNT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AMOUNT_RE.exec(text)) !== null) {
    const [full, sign, symbol, digits, unit] = m;
    if (full === undefined || digits === undefined) continue;
    const idx = m.index;
    const before = idx > 0 ? text[idx - 1] : "";
    if (before && TOKEN_BEFORE.test(before)) continue;
    const after = text.slice(idx + full.length);
    const hasSep = digits.includes(",");
    const isLong = digits.replace(/\.\d+$/, "").length >= 6;
    // 既无单位也无千分位、位数又短的数字（例如「6 大类」「3 份合同」）不作为金额
    if (!unit && !symbol && !hasSep && !isLong) continue;
    if (REJECT_SUFFIX.test(after)) continue;
    const base = toCents(digits, unit);
    if (base === null) continue;
    const cents = sign === "-" || sign === "−" ? -base : base;
    out.push({
      raw: `${sign ?? ""}${digits}${unit ?? ""}`,
      match: full.replace(/^\s+|\s+$/g, ""),
      cents,
      index: idx,
      context: text.slice(Math.max(0, idx - 24), idx + full.length + 16).replace(/\s+/g, " "),
    });
    if (full.length === 0) AMOUNT_RE.lastIndex += 1;
  }
  return out;
}

const MAX_NODES = 20000;

/** 递归收集工具结果里的数值，同时登记「元」与「分」两种量纲（键为分） */
export function collectToolCents(results: unknown[]): Set<number> {
  const set = new Set<number>();
  const budget = { n: 0 };
  const walk = (v: unknown, depth: number): void => {
    if (depth > 12 || budget.n++ > MAX_NODES) return;
    if (v === null || v === undefined) return;
    if (typeof v === "number") {
      if (Number.isFinite(v)) {
        set.add(Math.round(v * 100));
        set.add(Math.round(v));
      }
      return;
    }
    if (typeof v === "string") {
      const s = v.trim().replace(/,/g, "");
      if (/^-?\d+(\.\d+)?$/.test(s)) {
        const n = Number(s);
        if (Number.isFinite(n)) {
          set.add(Math.round(n * 100));
          set.add(Math.round(n));
        }
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    if (typeof v === "object") {
      for (const item of Object.values(v as Record<string, unknown>)) walk(item, depth + 1);
    }
  };
  for (const r of results) walk(r, 0);
  return set;
}

/**
 * 金额核对标记的键：只用值（分）。
 * 同一金额在结论里常有多种写法（表格里的 `84,444.44` 与正文的「84,444.44 元」），
 * 税务师确认的是这个数有没有出处，因此共用一个键：标记一次即覆盖全部写法。
 */
export function amountKey(a: { cents: number }): string {
  return String(a.cents);
}

/** 符号不敏感匹配：差异金额常以负数呈现，工具结果里可能是正数（或相反） */
function inPool(cents: number, pool: Set<number>): boolean {
  return pool.has(cents) || pool.has(-cents);
}

/**
 * 结论金额溯源：先查工具调用结果，再查客户指令原文，两边都没有的才列为未溯源。
 * 三级口径避免把「转述客户提供的合同金额」误判成模型口算。
 */
export function traceAmounts(text: string, results: unknown[], instruction = ""): TraceResult {
  const amounts = extractAmounts(text);
  const pool = collectToolCents(results);
  const inputPool = new Set(extractAmounts(instruction).map((a) => a.cents));
  let traced = 0;
  let fromInput = 0;
  const untraced: Amount[] = [];
  for (const a of amounts) {
    if (inPool(a.cents, pool)) traced += 1;
    else if (inPool(a.cents, inputPool)) fromInput += 1;
    else untraced.push(a);
  }
  return { total: amounts.length, traced, fromInput, untraced };
}
