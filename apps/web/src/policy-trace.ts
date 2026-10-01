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
import { retainedSourceAt, urlsOfCall } from "./search-evidence.ts";

/**
 * 只在留存网页正文里找到出处的文号，附上它来自哪一页。
 *
 * 带地址是因为「仅正文提到」这一档要能**行动**：复核人真正要做的是点开那一页，确认这个文号是
 * 该页主题还是被顺带提到（侧栏的相关文件列表、正文里一句「同时废止 2020年第24号」）。
 * 只给一个计数的话，这一档就只是个装饰性数字。
 */
export type BodyTracedRef = DocRef & {
  /** 命中该文号的留存正文所属页面地址；那份结果里没有可归属的地址时为空串 */
  sourceUrl: string;
  /** 同一份结果里的标题（取不到时 urlsOfCall 会退回用地址本身） */
  sourceTitle: string;
  /**
   * 这个地址是哪一级依据给出的：`structured` = 工具结果的结构化字段（url / urls[] / results[]），
   * `body-line` = 留存正文末尾的 `Source: 标题 (地址)` 行，`""` = 两级都给不出、地址留空。
   *
   * 单列出来是因为「点得开」不等于「依据同级」：来源行归属是按命中位置往后找最近的一条，判据比
   * 结构化字段弱一档，界面与交付 MD 上要说清是哪一种；门禁也要能断言这条路径真的被走到了，
   * 否则哪天每处都碰巧有结构化地址，这段代码从未执行也不会被发现。
   */
  sourceVia: "structured" | "body-line" | "";
  /** 有几份留存正文里出现了这个文号。多份互不相同的来源同时提到，比一份更站得住 */
  sourceCount: number;
};

/**
 * `sourceVia` 的界面文案与依据说明。放在这里而不是组件里，是因为界面徽章、交付 MD 与门禁三处
 * 都要说同一件事，各写一遍迟早漂（档位名改了、说明改了，总有一处忘）。
 *
 * 文案里刻意不用 Markdown 记号：这些字符串会直接进 JSX 文本与 title 属性，写反引号或方括号
 * 就会被 scan:uimd 判成「界面出现 Markdown 原文」。
 */
export const SOURCE_VIA_TEXT: Record<BodyTracedRef["sourceVia"], string> = {
  structured: "结构化字段",
  "body-line": "正文来源行",
  "": "无地址",
};

export const SOURCE_VIA_HINT: Record<BodyTracedRef["sourceVia"], string> = {
  structured: "地址来自工具结果的结构化字段（url / urls 数组 / results 数组），依据与那条结果本身同级。",
  "body-line":
    "地址来自留存正文里这条结果末尾的来源行（形如 Source: 标题 (地址)），按文号命中的位置往后归属到最近的一条。依据弱一档：点开后要确认这个文号是该页主题，还是只被顺带提到（侧栏的相关文件列表、正文里一句「同时废止某号」）。",
  "": "这份留存正文里认不出可归属的来源行：可能只留了查询词，也可能命中落在检索词行或跨了小节。宁可不给地址也不猜——猜出来的链接会把复核人引到不相干的页面上。",
};

/**
 * 文号相关清单每表最多列多少条：界面的「仅在留存正文中出现」一组、交付 MD 的「待人工确认」表
 * 与「留存正文出处」表都用它。
 *
 * 三个消费点此前各写了一遍 `slice(0, 20)`：改一处不改另一处，就会出现「面板列了 20 条、
 * 交付 MD 只列 10 条」这种两边对不上的账。抽成一份，由门禁断言每处都引用它。
 */
export const DOC_REF_TABLE_LIMIT = 20;

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
  bodyTracedRefs: BodyTracedRef[];
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

/** 一次工具调用留存的网页正文（没有留存就是空串） */
function retainedBodyOf(result: unknown): string {
  const o =
    result !== null && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null;
  const v = o?.[RETAINED_TEXT_KEY];
  return typeof v === "string" ? v : "";
}

/**
 * 从留存正文的来源行给这个文号找一个可点开的地址，找不到就返回 null。
 *
 * 命中位置用 extractDocRefs 在正文里重新取一次，而不是复用上面那袋归一化字符串：归一化把括号与
 * 空格都抹平了，位置也跟着没了，而归属恰恰要靠位置（web_search 的来源行写在结果**后面**）。
 * 两个口径不完全重合是可能的（归一化包含匹配命中了、提取却提不出来的写法），那种情况这里返回
 * null，表现为「有出处但地址留空」，落在安全侧。
 */
function bodyLineSource(body: string, core: string): { url: string; title: string } | null {
  if (body === "") return null;
  for (const hit of extractDocRefs(body)) {
    if (hit.core !== core) continue;
    const s = retainedSourceAt(body, hit.index);
    if (s) return s;
  }
  return null;
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
 * `toolNames` 是**一袋名字**，只用来判断「本任务有没有用过只留元数据的检索工具」，与 `results`
 * 不按下标配对——三个生产调用点传的都是「全部调用的名字」配「只有成功调用的结果」，长度就不相等。
 * 想按结果取信息（比如留存正文属于哪个页面）请直接从 result 对象上取，别指望 toolNames[i] 对得上
 * results[i]。
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
  // 正文池按「一次工具调用一份」保留，命中时能回指是哪个页面。地址走 urlsOfCall 的形状识别
  //（它的 toolName 参数是显式弃用的，函数体里 `void toolName`），因此不依赖上面那袋名字的下标。
  const bodyEntries = results
    .map((r) => ({ pool: collectRefStrings([r], "body"), urls: urlsOfCall("", r), body: retainedBodyOf(r) }))
    .filter((e) => e.pool.length > 0);
  const rechecked = recheckedSources.map((s) => normalizeRef(s)).filter((s) => s !== "");
  const inMeta = (core: string): boolean => metaPool.some((s) => s.includes(core));
  const bodyHits = (
    core: string,
  ): Array<{ pool: string[]; urls: Array<{ url: string; title: string }>; body: string }> =>
    bodyEntries.filter((e) => e.pool.some((s) => s.includes(core)));
  const inBody = (core: string): boolean => bodyHits(core).length > 0;
  const inRecheck = (core: string): boolean => rechecked.some((s) => s === core || s.includes(core));
  const missing = refs.filter((r) => !inMeta(r.core) && !inBody(r.core) && !inRecheck(r.core));
  const bodyOnly = refs.filter((r) => !inMeta(r.core) && inBody(r.core));
  const metadataOnly = toolNames.some((n) => METADATA_ONLY_SEARCH_TOOLS.has(n));
  return {
    total: refs.length,
    traced: refs.length - missing.length,
    tracedByBody: bodyOnly.length,
    bodyTracedRefs: bodyOnly.map((r) => {
      const hits = bodyHits(r.core);
      // 命中的往往不止一份。归属地址分两级：先看结构化字段（urlsOfCall 认得的那三种形状），
      // 再看留存正文末尾的来源行（web_search 的结构化字段只有查询词，地址写在正文里）。
      // 实测此前「仅正文提到」2 处只有 1 处带地址，缺的那处正是只撞上 web_search。
      // 两级都给不出地址时如实留空串，不硬凑一个。
      const u = hits.find((e) => e.urls.length > 0)?.urls[0];
      const line = u ? null : hits.map((e) => bodyLineSource(e.body, r.core)).find((s) => s !== null);
      return {
        ...r,
        sourceUrl: u?.url ?? line?.url ?? "",
        sourceTitle: u?.title ?? line?.title ?? "",
        sourceVia: u ? "structured" : line ? "body-line" : "",
        sourceCount: hits.length,
      };
    }),
    tracedByRecheck: refs.filter((r) => !inMeta(r.core) && !inBody(r.core) && inRecheck(r.core)).length,
    unverifiable: metadataOnly ? missing.length : 0,
    unverifiableRefs: metadataOnly ? missing : [],
    untraced: metadataOnly ? [] : missing,
  };
}
