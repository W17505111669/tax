/**
 * 政策文号溯源：结论里引用的税收规范性文件文号，是否真的出现在工具结果里。
 * 与金额溯源同一套思路——作品主张「政策依据先查快照、再联网核验」，这一节把主张变成可核对的清单。
 *
 * 匹配口径：提取文号的「核心部分」（如 `〔2015〕119号`、`2017年第40号`），
 * 归一化括号与空格后在工具结果的任意字符串里做包含匹配。用核心而不是整段前缀，
 * 是因为结论里常写成「根据财税〔2015〕119号」「财税〔2015〕119 号规定」等不同写法。
 * 纯函数，便于 apps/api/scripts/verify-policy-trace.ts 直接校验。
 */

import { plainContext } from "./md-text.ts";

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
  /**
   * 其中只靠留存网页正文取得的条数：工具结果的结构化字段（标题、文号列表、政策库条目）里没有，
   * 只在抓下来的正文里出现过。
   *
   * 单列出来是因为这两种依据的强度不同。结构化字段里的文号基本就是那条结果的主题；正文里出现
   * 则可能只是被顺带提到（页面侧栏的「相关文件」列表、正文里一句「同时废止 2020年第24号」）。
   * 混在一个「有出处」里，复核人就看不出哪几处需要再点开原文确认一次。
   */
  tracedByBody: number;
  /**
   * 与 tracedByBody 同一批文号的明细。
   *
   * 只给个数字，复核人还是不知道要去点哪一条——「依据可见」得能看到是哪几处、在结论里怎么写的。
   * 与 untraced / unverifiableRefs 一样带上下文，界面上直接列出来。
   */
  bodyTracedRefs: DocRef[];
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
      // 与金额溯源同一口径：上下文既要给人看，也要拿去拼复查检索词，不能带着 Markdown 记号
      const ctx = plainContext(text.slice(Math.max(0, m.index - 28), m.index + raw.length + 20));
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

/**
 * agent-factory 给联网类工具留存网页正文用的字段名（见 packages/agent-core/src/agent-factory.ts）。
 * 拆池全靠认这个键，所以名字改了两边都得改——verify:agents 与 verify:policytrace 各有一条断言盯着。
 */
export const RETAINED_TEXT_KEY = "retainedText";

/**
 * 收集哪一类字符串：
 * - `all`：全部（含留存正文），与拆池之前的口径一致；
 * - `meta`：跳过留存正文字段，即工具结果的结构化部分；
 * - `body`：只收留存正文字段。
 */
export type RefPoolKind = "all" | "meta" | "body";

/**
 * 递归收集工具结果里的字符串（归一化后），用于包含匹配。
 *
 * 三种口径共用同一套遍历，只在「这个字符串是不是留存正文」上分流——同一件事不写两遍，
 * 否则深度上限、字符串预算这些细节迟早漂。每次调用有自己的一份 MAX_STRINGS 预算：
 * 共用一份会让长正文把元数据挤出预算，出现「元数据里明明有，却判成只靠正文才溯到」。
 */
export function collectRefStrings(results: unknown[], kind: RefPoolKind = "all"): string[] {
  const out: string[] = [];
  const budget = { n: 0 };
  const walk = (v: unknown, depth: number, key: string): void => {
    if (depth > 12 || budget.n++ > MAX_STRINGS || out.length >= MAX_STRINGS) return;
    if (typeof v === "string") {
      const isBody = key === RETAINED_TEXT_KEY;
      if (kind === "meta" && isBody) return;
      if (kind === "body" && !isBody) return;
      out.push(normalizeRef(v));
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      // 数组元素沿用父键：retainedText 是纯字符串，这里只是为了不把嵌套结构里的键丢掉
      for (const item of v) walk(item, depth + 1, key);
      return;
    }
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) walk(item, depth + 1, k);
  };
  for (const r of results) walk(r, 0, "");
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
 *
 * 三种依据的优先级是 **元数据 > 留存正文 > 联网复查**：一条文号只算在它最强的那类依据上，
 * 三个计数相加恒等于 traced，不会因为「正文里也有、复查也判过」而被重复计数。
 */
export function traceDocRefs(
  text: string,
  results: unknown[],
  toolNames: string[] = [],
  recheckedSources: string[] = [],
): RefTraceResult {
  const refs = extractDocRefs(text);
  const metaPool = collectRefStrings(results, "meta");
  const bodyPool = collectRefStrings(results, "body");
  const rechecked = recheckedSources.map((s) => normalizeRef(s)).filter((s) => s !== "");
  const inMeta = (core: string): boolean => metaPool.some((s) => s.includes(core));
  const inBody = (core: string): boolean => bodyPool.some((s) => s.includes(core));
  const inRecheck = (core: string): boolean => rechecked.some((s) => s === core || s.includes(core));
  const missing = refs.filter((r) => !inMeta(r.core) && !inBody(r.core) && !inRecheck(r.core));
  const bodyOnly = refs.filter((r) => !inMeta(r.core) && inBody(r.core));
  const metadataOnly = toolNames.some((n) => METADATA_ONLY_SEARCH_TOOLS.has(n));
  return {
    total: refs.length,
    traced: refs.length - missing.length,
    tracedByBody: bodyOnly.length,
    bodyTracedRefs: bodyOnly,
    tracedByRecheck: refs.filter((r) => !inMeta(r.core) && !inBody(r.core) && inRecheck(r.core)).length,
    unverifiable: metadataOnly ? missing.length : 0,
    unverifiableRefs: metadataOnly ? missing : [],
    untraced: metadataOnly ? [] : missing,
  };
}
