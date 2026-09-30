/**
 * 政策文号溯源：结论里引用的税收规范性文件文号，是否真的出现在工具结果里。
 * 与金额溯源同一套思路——作品主张「政策依据先查快照、再联网核验」，这一节把主张变成可核对的清单。
 *
 * 匹配口径：提取文号的「核心部分」（如 `〔2015〕119号`、`2017年第40号`），
 * 归一化括号与空格后在工具结果的任意字符串里做包含匹配。用核心而不是整段前缀，
 * 是因为结论里常写成「根据财税〔2015〕119号」「财税〔2015〕119 号规定」等不同写法。
 * 纯函数，便于 apps/api/scripts/verify-policy-trace.ts 直接校验。
 */

export type DocRef = {
  core: string;
  text: string;
  index: number;
  context: string;
  occurrences: number;
  /**
   * 该文号每一处出现的上下文（含首次，最多 MAX_REF_CONTEXTS 处）。
   *
   * 同一文号在结论里常出现多次，首次可能是光杆写法（「附件表单先后被 2020年第24号、2021年第34号
   * 部分废止」），后面某次才带机关（「申报说明先后被国家税务总局公告2020年第24号」）。按核心去重时
   * 只留首次上下文，等于把机关白丢掉——实测 6 处补不上出处的文号里有 1 处正是这个原因。
   * 去重键仍是 core，因此落库主键与既有记录不受影响。
   */
  contexts: string[];
};

export type RefTraceResult = {
  /** 结论中出现的文号总数（按核心去重） */
  total: number;
  /** 有出处的：工具留存结果里出现该文号，或联网复查已判定「找到公开出处」 */
  traced: number;
  /** 其中靠联网复查取得出处的条数（工具留存里没有，但 ref_checks 里有可点开的原文与检索时间） */
  tracedByRecheck: number;
  /** 找不到出处，但本任务用过「只持久化元数据」的联网检索工具，因此无法从留存数据核验 */
  unverifiable: number;
  /** 与 unverifiable 同一批文号的明细，供「联网复查」逐条使用 */
  unverifiableRefs: DocRef[];
  /** 找不到出处且本任务没有上述检索工具 → 需要人工确认（可能来自模型知识） */
  untraced: DocRef[];
};

/**
 * 这些联网检索工具（社区扩展 pi-web-access）只把查询词、条数、检索 ID 等元数据写回工具结果，
 * 不落库检索到的标题与正文，因此其中出现的文号无法从留存数据核验——如实标为「无法核验」而不是「无出处」。
 */
export const METADATA_ONLY_SEARCH_TOOLS = new Set(["web_search", "fetch_content"]);

const REF_PATTERNS: RegExp[] = [
  /[〔[【]\s*\d{4}\s*[〕\]】]\s*第?\s*\d+\s*号/g,
  /\d{4}\s*年第\s*\d+\s*号/g,
];

/** 单个文号最多记几处上下文：够挑出带机关的那一处，又不至于把长结论整篇抄进来 */
const MAX_REF_CONTEXTS = 8;

/** 归一化：去掉全部空白，括号统一成半角方括号，便于跨写法匹配 */
export function normalizeRef(s: string): string {
  return s.replace(/\s+/g, "").replace(/[〔【]/g, "[").replace(/[〕】]/g, "]");
}

/** 从文本中提取文号（按核心去重，记录出现次数与首次出现的上下文） */
export function extractDocRefs(text: string): DocRef[] {
  const out: DocRef[] = [];
  if (!text) return out;
  const byCore = new Map<string, DocRef>();
  for (const re of REF_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[0];
      const core = normalizeRef(raw);
      if (core.length < 4) continue;
      const ctx = text.slice(Math.max(0, m.index - 28), m.index + raw.length + 20).replace(/\s+/g, " ");
      const hit = byCore.get(core);
      if (hit) {
        hit.occurrences += 1;
        if (hit.contexts.length < MAX_REF_CONTEXTS) hit.contexts.push(ctx);
        continue;
      }
      byCore.set(core, {
        core,
        text: raw.trim(),
        index: m.index,
        context: ctx,
        occurrences: 1,
        contexts: [ctx],
      });
    }
  }
  for (const v of byCore.values()) out.push(v);
  return out.sort((a, b) => a.index - b.index);
}

const MAX_STRINGS = 8000;

/** 递归收集工具结果里的全部字符串（归一化后），用于包含匹配 */
export function collectRefStrings(results: unknown[]): string[] {
  const out: string[] = [];
  const budget = { n: 0 };
  const walk = (v: unknown, depth: number): void => {
    if (depth > 12 || budget.n++ > MAX_STRINGS || out.length >= MAX_STRINGS) return;
    if (typeof v === "string") {
      out.push(normalizeRef(v));
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    for (const item of Object.values(v as Record<string, unknown>)) walk(item, depth + 1);
  };
  for (const r of results) walk(r, 0);
  return out;
}

/**
 * 文号溯源：核心部分出现在任一工具结果字符串里，或联网复查已判定「找到公开出处」，即视为有出处；
 * 否则按是否用过元数据检索工具分级。
 *
 * 复查取得的出处同样是出处：`ref_checks` 里存着标题、地址、证据力分级与检索时间，界面上点
 * 文号徽章就能打开原文，交付包也带这份记录。只认工具留存结果会逼着 Agent 为了指标把同一个
 * 文号再检索一遍——实测就是写回续跑跑完「文号有出处」纹丝不动的原因。
 *
 * `recheckedSources` 传复查判定为 matched 的文号原文清单（按任务），为空时行为与旧版一致。
 */
export function traceDocRefs(
  text: string,
  results: unknown[],
  toolNames: string[] = [],
  recheckedSources: string[] = [],
): RefTraceResult {
  const refs = extractDocRefs(text);
  const pool = collectRefStrings(results);
  const rechecked = recheckedSources.map((s) => normalizeRef(s)).filter((s) => s !== "");
  const inPool = (core: string): boolean => pool.some((s) => s.includes(core));
  const inRecheck = (core: string): boolean => rechecked.some((s) => s === core || s.includes(core));
  const missing = refs.filter((r) => !inPool(r.core) && !inRecheck(r.core));
  const metadataOnly = toolNames.some((n) => METADATA_ONLY_SEARCH_TOOLS.has(n));
  return {
    total: refs.length,
    traced: refs.length - missing.length,
    tracedByRecheck: refs.filter((r) => !inPool(r.core) && inRecheck(r.core)).length,
    unverifiable: metadataOnly ? missing.length : 0,
    unverifiableRefs: metadataOnly ? missing : [],
    untraced: metadataOnly ? [] : missing,
  };
}
