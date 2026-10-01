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

import { plainContext } from "./md-text.ts";

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

/**
 * 数字后面跟这些字符时不视为金额（量词、日期、百分比、篇幅与行列计数）。
 *
 * 后面这组是实测补的：结论里写「PDF 共 37 页、28,263 字符，已解析」，`28,263` 带千分位、
 * 位数也够长，两道「不像金额」的守卫都拦不住，于是被当成一笔待人工确认的金额挂在缺口清单上。
 * 金额后面不会跟「字 / 页 / 行 / 列 / 张 / 笔」，收进来不会误杀真金额。
 */
const REJECT_SUFFIX = /^[%％年月日份条项次个大类人天字页行列张笔]/;

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
    // 判「这个数字是不是某个更长记号的一部分」要看紧挨记号起点的那个字符，不能看匹配起点：
    // 正则带前导 \s*，"限额: 175555.55 元" 的匹配从冒号后的空格起算，起点前一个字符是 ":"，
    // 整条金额就被当成 URL / 编号的一部分跳过了——冒号后的金额此前根本进不了溯源核对，等于给
    // 手算数字留了「写成 冒号+空格 就查不到」的口子。记号起点取第一个非空白字符，负号与货币
    // 符号都算记号的一部分（否则 "-460,000.00 元" 会因为紧邻自己的负号被误杀）。
    const tokenAt = Math.max(0, full.search(/\S/));
    const beforeIdx = idx + tokenAt;
    const before = beforeIdx > 0 ? text[beforeIdx - 1] : "";
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
      // 上下文是给人扫读的，也要拿去拼复查检索词：剥掉 Markdown 记号，别把 ** 与 > 一起端出来
      context: plainContext(text.slice(Math.max(0, idx - 24), idx + full.length + 16)),
    });
    if (full.length === 0) AMOUNT_RE.lastIndex += 1;
  }
  return out;
}

const MAX_NODES = 20000;

/**
 * 结果里的金额以「识别出的正文文本」形式存在的工具：OCR 与文档解析把整页文字放进一个字符串字段，
 * 数值不是 JSON 数字，只按数值收集就一条也收不到（实测 cc644639 的「人员人工 860000 元」在
 * textPreview 里，结论引用它却被判为待人工确认）。
 *
 * 只收客户自己上传资料的解析结果。**不收联网类工具**：网页正文里满是别人页面上的数字，
 * 一律收进来等于结论里写任何金额都能找到「出处」，这道核对就形同虚设。
 */
export const TEXT_AMOUNT_TOOLS = new Set(["parse_uploaded_files"]);

/** 递归收集工具结果里的数值，同时登记「元」与「分」两种量纲（键为分） */
export function collectToolCents(results: unknown[], options: { scanText?: boolean } = {}): Set<number> {
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
        return;
      }
      // 整段正文：用与结论侧同一个提取器扫，量纲与守卫（千分位、单位、拒绝后缀）自然一致
      if (options.scanText === true) {
        for (const a of extractAmounts(v)) {
          set.add(a.cents);
          set.add(Math.round(a.cents / 100));
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
export function traceAmounts(
  text: string,
  results: unknown[],
  instruction = "",
  /** 需要按正文扫描金额的工具结果（见 TEXT_AMOUNT_TOOLS），与 results 取并集 */
  textResults: unknown[] = [],
): TraceResult {
  const amounts = extractAmounts(text);
  const pool = collectToolCents(results);
  for (const c of collectToolCents(textResults, { scanText: true })) pool.add(c);
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

/** 未溯源金额的可能来源 */
export type UntracedOrigin = "web" | "unexplained";

/**
 * 待确认金额两类的界面文案与依据说明。
 *
 * 放在这里而不是各组件里，是因为台账列名、看板 tooltip、复核页徽章、就地标注的 label 说的是
 * 同一件事，各写一遍迟早漂（措辞改了、口径改了，总有一处忘）。文案里不用 Markdown 记号：
 * 这些字符串会直接进 JSX 文本与 title 属性，写反引号或方括号就会被 scan:uimd 判成界面出现原文。
 */
export const UNTRACED_ORIGIN_TEXT: Record<UntracedOrigin, string> = {
  web: "引自联网正文",
  unexplained: "三处均无出处",
};

export const UNTRACED_ORIGIN_HINT: Record<UntracedOrigin, string> = {
  web: "多半是摘引政策原文或案例里的数字。溯源池按既定口径不收联网正文（否则任何金额都能声称有出处），所以要核对的是引用抄得准不准，不是模型有没有口算。",
  unexplained:
    "工具结果、客户指令与联网正文都找不到。这一类混了两种情况：模型确实口算了，以及该任务运行时还没留存网页正文因而无从核对，所以不断言是口算——但这正是需要人逐条看的那一类。",
};

export type UntracedSplit = {
  /** 能在联网检索/读取类工具的正文里找到：多半是摘引政策原文或案例里的数字 */
  web: Amount[];
  /** 工具结果、客户指令、联网正文三处都找不到：这才是「模型可能口算」要拦的那一类 */
  unexplained: Amount[];
};

/**
 * 把未溯源金额再分两类：为什么找不到出处，决定了复核人该做什么。
 *
 * 溯源的工具结果池**故意不收联网正文**（见 TEXT_AMOUNT_TOOLS 的说明）：网页上满是别人页面里的
 * 数字，一律收进来等于结论写任何金额都能找到「出处」，这道核对就形同虚设。代价是纯检索类任务里
 * 摘引政策原文的数字会全部落进「待人工确认」，与「模型口算出来的数」混在同一个数字里——实测两个
 * 检索类任务 23 处待确认**全部**属于前者，而后者才是真正要拦的，混在一起时它一条也看不见。
 *
 * 所以这里只**分类、不改判定**：能在联网正文里找到的仍然算未溯源（不进可溯源池、不算 traced），
 * 只是标出可能来源，让复核人知道该核对「引用抄得准不准」而不是「有没有口算」。
 *
 * webResults 传联网类工具的结果（工具名单用 search-evidence.ts 的 SEARCH_TOOL_NAMES，与时间线、
 * 进度推导、引用提取共用同一批名字）；按正文扫描，因为网页内容在结果里是整段文本而不是数值字段。
 */
export function classifyUntraced(untraced: Amount[], webResults: unknown[]): UntracedSplit {
  const pool = collectToolCents(webResults, { scanText: true });
  const web: Amount[] = [];
  const unexplained: Amount[] = [];
  for (const a of untraced) (inPool(a.cents, pool) ? web : unexplained).push(a);
  return { web, unexplained };
}
