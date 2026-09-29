/**
 * 证据复查：把「无法核验的政策文号」从死标签变成可执行、可留痕的动作。
 *
 * 背景：联网检索扩展（web_search / fetch_content）只把查询元数据写回工具结果，
 * 因此结论里引用的文号常常无法从留存数据核验。这一层用自建的检索通道复查一遍，
 * 并把「找到了什么」按四级如实记录：找到公开出处 / 有候选待人工确认 / 未检索到 / 检索失败。
 *
 * 分级与判定都是纯函数，服务端（apps/api/src/services/ref-checks.ts）与验证脚本共用同一份实现，
 * 检索本身通过参数注入，便于离线校验。
 */

import { gradeCitation } from "./citation-grade.ts";
import { normalizeRef } from "./policy-trace.ts";
import type { RefTraceResult } from "./policy-trace.ts";

/** docref = 政策文号复查（citation 预留给弱证据引用复查） */
export type RefCheckKind = "docref" | "citation";

export type RefCheckVerdict = "matched" | "candidate" | "empty" | "error";

export const REF_VERDICT_TEXT: Record<RefCheckVerdict, string> = {
  matched: "已找到公开出处",
  candidate: "有候选待确认",
  empty: "未检索到",
  error: "检索失败",
};

export const REF_VERDICT_HINT: Record<RefCheckVerdict, string> = {
  matched: "公开检索结果的标题或摘要里出现了这个文号，点证据链接可核对原文",
  candidate: "检索到了相关页面，但标题与摘要里没有出现这个文号，请点开候选页人工确认",
  empty: "检索引擎没有返回可用结果（无关结果与门户首页已被过滤），请改用政策快照检索或人工核对",
  error: "检索请求失败或被拦截，请稍后重试",
};

export type RefCheckTarget = {
  /** 落库主键的一部分：kind + 归一化文本 */
  key: string;
  kind: RefCheckKind;
  /** 文号原文（如「财税〔2015〕119号」）或引用标题 */
  text: string;
  /** 文号在结论中的上下文，用于补充检索词 */
  context?: string;
  /** 检索补充词：弱证据引用的标题常常只有一两个词，补上结论里的领域词才构成能用的检索词 */
  hint?: string;
  /** 复查引用时要排除的地址：这条弱证据本身不能被当成自己的替代来源 */
  excludeUrl?: string;
};

/** 复查记录主键：同一文号在同一任务里只保留最新一次结果 */
export function refKey(kind: RefCheckKind, text: string): string {
  return `${kind}:${normalizeRef(text)}`;
}

/** 前导虚词：出现在词组开头时去掉（「根据财税」→「财税」、「按国税函」→「国税函」） */
const LEAD_WORDS = [
  "依据",
  "根据",
  "按照",
  "依照",
  "参照",
  "按",
  "见",
  "据",
  "如",
  "即",
  "号",
  "与",
  "和",
  "及",
  "的",
  "经",
  "由",
  "在",
  "中",
  "等",
];
/** 收尾虚词：出现在词组结尾时去掉（「第六条规定」→「第六条」）；条款项本身有意义，不列入 */
const TAIL_WORDS = ["的", "中", "等", "规定"];

/** 去掉词组两端的虚词；全部被去掉时返回空串（宁可不加关键词，也不加噪声） */
export function trimEdgeWords(s: string): string {
  let out = s;
  for (let guard = 0; guard < 8 && out.length > 0; guard += 1) {
    const before = out;
    for (const w of LEAD_WORDS) {
      if (out.startsWith(w)) {
        out = out.slice(w.length);
        break;
      }
    }
    for (const w of TAIL_WORDS) {
      if (out.length > 0 && out.endsWith(w)) {
        out = out.slice(0, -w.length);
        break;
      }
    }
    if (out === before) break;
  }
  return out;
}

/**
 * 文号前面的发文机关（「根据财税〔2015〕119号」→「财税」，「国家税务总局公告2017年第40号」→ 原样保留）。
 * 只靠「〔2015〕119号」检索命中率很低，补上发文机关才是一条能用的检索词。
 */
export function refPrefix(context: string, refText: string, maxChars = 12): string {
  const idx = context.indexOf(refText);
  if (idx <= 0) return "";
  const m = context.slice(Math.max(0, idx - maxChars), idx).match(/[\u4e00-\u9fa5]{2,}$/);
  return m ? trimEdgeWords(m[0]) : "";
}

/**
 * 从上下文里挑一段最有区分度的中文关键词。
 * 只取去掉虚词后最长的一段连续中文（≥4 字），避免把整句话塞进检索词——检索词越长，
 * 相关度门槛按比例抬得越高，反而会滤掉正确结果。
 */
export function contextKeywords(context: string, refText: string, prefix = "", maxChars = 14): string {
  if (!context) return "";
  let cleaned = context.split(refText).join(" ");
  if (prefix !== "") cleaned = cleaned.split(prefix).join(" ");
  const runs = (cleaned.match(/[\u4e00-\u9fa5]{4,}/g) ?? [])
    .map(trimEdgeWords)
    .filter((s) => s.length >= 4);
  if (runs.length === 0) return "";
  const best = runs.slice().sort((a, b) => b.length - a.length)[0] ?? "";
  return best.slice(0, maxChars);
}

/** 站点后缀一律去掉：拿「研发_百度百科」去检索只会又搜回百科 */
export function stripSiteSuffix(title: string): string {
  const cleaned = title
    .replace(/[_|\-—–]\s*(百度百科|百度知道|维基百科|知乎|MBA智库百科|豆丁网|道客巴巴|文库|小说网)[^\s_|\-—–]*$/u, "")
    .trim();
  return cleaned === "" ? title.trim() : cleaned;
}

/** 复查用的检索词 */
export function buildRefQuery(t: RefCheckTarget): string {
  if (t.kind === "citation") {
    return [stripSiteSuffix(t.text), t.hint ?? ""].filter((s) => s.trim() !== "").join(" ");
  }
  const context = t.context ?? "";
  const prefix = refPrefix(context, t.text);
  const kw = contextKeywords(context, t.text, prefix);
  return [`${prefix}${t.text.trim()}`, kw].filter((s) => s !== "").join(" ");
}

/**
 * 复查检索词候选：先用「发文机关 + 文号 + 上下文关键词」，拿不到结果再退到最紧凑的
 * 「发文机关 + 文号」（去掉文号内部空格，贴近正式写法）。
 * 检索词越长相关度门槛按比例越高，紧凑写法在引擎只返回导航类结果时更容易命中原文页。
 */
export function refQueryVariants(t: RefCheckTarget): string[] {
  if (t.kind === "citation") {
    // 先带领域补充词，拿不到结果再退回只用清理后的标题
    const withHint = buildRefQuery(t);
    const bare = stripSiteSuffix(t.text);
    return [withHint, bare].filter((q, i, arr) => q !== "" && arr.indexOf(q) === i);
  }
  const full = buildRefQuery(t);
  const prefix = refPrefix(t.context ?? "", t.text);
  const tight = `${prefix}${t.text.replace(/\s+/g, "")}`.trim();
  return [full, tight].filter((q, i, arr) => q !== "" && arr.indexOf(q) === i);
}

/** 需要找替代来源的弱证据引用（门户首页 / 百科词条 / 检索页），按引用清单顺序取前 limit 条 */
export function citationTargets(
  citations: Array<{ title: string; url: string; grade: string }>,
  hint: string,
  limit = 10,
): RefCheckTarget[] {
  return citations
    .filter((c) => c.grade === "weak")
    .slice(0, limit)
    .map((c) => ({
      key: refKey("citation", c.url),
      kind: "citation" as const,
      text: c.title,
      hint,
      excludeUrl: c.url,
    }));
}

/** 检索结果条目（与 @tax/business-tools 的 WebSearchResult 形状兼容，但不引入 Node 依赖） */
export type RefSearchHit = { title: string; url: string; snippet?: string; relevance?: number };

/** 一次检索的结果：hits 为过滤后的可用条目；failed 表示引擎全部不可用 */
export type RefSearchOutcome = { hits: RefSearchHit[]; note?: string; failed?: boolean };

export type RefCheckEvidence = { title: string; url: string; snippet: string; grade: string; gradeReason: string };

export type RefCheckResult = { verdict: RefCheckVerdict; evidence: RefCheckEvidence | null; note: string };

function toEvidence(h: RefSearchHit): RefCheckEvidence {
  const g = gradeCitation(h.url, h.title);
  return { title: h.title, url: h.url, snippet: h.snippet ?? "", grade: g.grade, gradeReason: g.reason };
}

/**
 * 通用词：两边标题里都出现也不代表谈的是同一件事（国名、站点类型、行业泛称、URL 碎片）。
 * 主题相关性宁可漏判（降为 candidate 交人工确认），不可误判成「找到官方原文」。
 */
const GENERIC_TOPIC_TOKENS = new Set([
  "国家", "中国", "中华", "人民", "共和", "和国", "政府", "政务", "服务", "平台", "系统", "网站",
  "首页", "官网", "官方", "百科", "词条", "知乎", "下载", "工具", "信息", "数据", "查询", "文档",
  "文件", "页面", "中心", "管理", "总局", "税务", "纳税", "税收", "财政", "12366",
  "www", "com", "cn", "gov", "html", "htm", "http", "https", "pdf", "asp", "aspx", "php", "jsp",
]);

/** 粗粒度分词：中文取二字滑窗，英文与数字取 3 字以上的词，最后去掉通用词 */
export function topicTokens(text: string): string[] {
  const cleaned = (text ?? "").toLowerCase();
  const ascii = cleaned.match(/[a-z0-9]{3,}/g) ?? [];
  const runs = cleaned.match(/[\u4e00-\u9fff]+/g) ?? [];
  const bigrams: string[] = [];
  for (const run of runs) {
    if (run.length === 1) bigrams.push(run);
    for (let i = 0; i + 2 <= run.length; i += 1) bigrams.push(run.slice(i, i + 2));
  }
  return [...new Set([...ascii, ...bigrams])].filter((t) => !GENERIC_TOPIC_TOKENS.has(t));
}

/**
 * 原引用与候选页的共同主题词（命中页标题与摘要一起看）。
 * 空数组表示看不出两者谈的是同一件事——这时即使域名是官方的也只给候选，不给 matched。
 */
export function topicOverlap(originalTitle: string, hitTitle: string, hitSnippet = ""): string[] {
  const want = new Set(topicTokens(originalTitle));
  if (want.size === 0) return [];
  return topicTokens(`${hitTitle} ${hitSnippet}`).filter((t) => want.has(t));
}

/** 候选排序：官方原文优先，其次专业来源，再看相关度 */
const GRADE_RANK: Record<string, number> = { official: 0, professional: 1, weak: 2 };

function bestHit(hits: RefSearchHit[]): RefSearchHit | null {
  if (hits.length === 0) return null;
  return hits
    .map((h) => ({ h, g: GRADE_RANK[gradeCitation(h.url, h.title).grade] ?? 3 }))
    .sort((a, b) => a.g - b.g || (b.h.relevance ?? 0) - (a.h.relevance ?? 0))[0]!.h;
}

/**
 * 复查判定：
 * - 引用（citation）除了「官方域名 + 非入口页」，还要与原引用有共同主题词，
 *   否则同域名下的 App 下载页、工具页会被当成政策原文写进修订指令。
 * - 文号（docref）：标题或摘要里出现归一化后的文号核心才算「找到公开出处」，
 *   否则即使检索到相关页面也只给「有候选待确认」，不把候选当成依据；
 * - 引用（citation）：找到证据力更强的具体文件页才算 matched。
 */
export function gradeRefCheck(t: RefCheckTarget, outcome: RefSearchOutcome): RefCheckResult {
  const note = outcome.note ?? "";
  if (outcome.failed) {
    return { verdict: "error", evidence: null, note: note === "" ? "检索请求失败或被拦截" : note };
  }
  if (outcome.hits.length === 0) {
    return { verdict: "empty", evidence: null, note: note === "" ? "检索引擎未返回可用结果" : note };
  }
  if (t.kind === "citation") {
    // 排除这条引用自身，否则「找到替代来源」会变成找到自己
    const pool = t.excludeUrl ? outcome.hits.filter((h) => h.url !== t.excludeUrl) : outcome.hits;
    if (pool.length === 0) {
      return { verdict: "empty", evidence: null, note: "只检索到这条引用本身，没有找到可替换的来源" };
    }
    // 官方域名只是必要条件：还要与原引用谈的是同一件事，否则会把同域名下的
    // App 下载页、工具页当成政策原文写进修订指令
    const isOfficial = (h: RefSearchHit) => gradeCitation(h.url, h.title).grade === "official";
    const official = pool.find((h) => isOfficial(h) && topicOverlap(t.text, h.title, h.snippet ?? "").length > 0);
    if (official) {
      return {
        verdict: "matched",
        evidence: toEvidence(official),
        note: `检索到政府或税务机关站点的具体文件页，且与原引用有共同主题词，可替换原弱证据引用`,
      };
    }
    const unrelated = pool.find(isOfficial);
    if (unrelated) {
      return {
        verdict: "candidate",
        evidence: toEvidence(unrelated),
        note: `检索到官方站点页面，但与原引用「${t.text}」没有共同主题词，看不出谈的是同一件事，需人工确认后再替换`,
      };
    }
    const best = bestHit(pool);
    // 只剩同类门户首页或百科词条时不算候选：换一条弱证据没有意义
    if (best && gradeCitation(best.url, best.title).grade !== "weak") {
      return {
        verdict: "candidate",
        evidence: toEvidence(best),
        note: "未检索到官方原文，给出证据力更高的候选页，请人工确认后再替换",
      };
    }
    return { verdict: "empty", evidence: null, note: "只检索到同类门户首页或百科词条，没有可替换的官方原文" };
  }
  const core = normalizeRef(t.text);
  const hit = outcome.hits.find((h) => normalizeRef(`${h.title} ${h.snippet ?? ""}`).includes(core));
  if (hit) {
    return { verdict: "matched", evidence: toEvidence(hit), note: "公开检索结果的标题或摘要中出现该文号" };
  }
  const best = bestHit(outcome.hits);
  return {
    verdict: "candidate",
    evidence: best ? toEvidence(best) : null,
    // 判定说明优先于引擎说明：引擎尝试过程另存 attempts，界面单独展示
    note: `检索到 ${outcome.hits.length} 条相关页面，但标题与摘要里没有出现「${t.text}」`,
  };
}

export type RefCheckSummary = {
  total: number;
  matched: number;
  candidate: number;
  empty: number;
  error: number;
  /** 最近一次复查时间；null 表示从未复查 */
  checkedAt: string | null;
};

/** 复查结果汇总：界面计数、交付自检与交付包清单共用同一口径 */
export function summarizeRefChecks(
  list: Array<{ verdict: RefCheckVerdict; checkedAt?: string | null }>,
): RefCheckSummary {
  const out: RefCheckSummary = { total: list.length, matched: 0, candidate: 0, empty: 0, error: 0, checkedAt: null };
  for (const c of list) {
    out[c.verdict] += 1;
    if (c.checkedAt && (out.checkedAt === null || c.checkedAt > out.checkedAt)) out.checkedAt = c.checkedAt;
  }
  return out;
}

/** 需要复查的文号：待人工确认 + 无法从留存数据核验（两类都还没有可核对的出处） */
export function refCheckTargets(trace: RefTraceResult): RefCheckTarget[] {
  return [...trace.untraced, ...trace.unverifiableRefs].map((r) => ({
    key: refKey("docref", r.text),
    kind: "docref" as const,
    text: r.text,
    context: r.context,
  }));
}

/**
 * 复查之后，还剩多少处文号没有出处。
 * matched 表示已经拿到可点击核对的公开出处，因此从待处理里扣除；
 * candidate / empty / error 都还需要人工处理，照旧计入。
 */
export function pendingAfterRecheck(pending: number, summary: RefCheckSummary): number {
  return Math.max(0, pending - summary.matched);
}

/** 已经拿到公开出处的 key 集合 */
export function matchedKeys(checks: Array<{ key: string; verdict: RefCheckVerdict }>): Set<string> {
  return new Set(checks.filter((c) => c.verdict === "matched").map((c) => c.key));
}

/**
 * 批量复查的目标筛选：去掉已经找到公开出处的。
 * 不筛会有两个后果——预算花在已解决的项目上，以及一次检索失败就把之前的证据覆盖掉：
 * 点一下「批量复查文号」，看板上的证据反而变少。这是实测踩到的（12 处复查跑完，
 * 「复查到出处」从 9 掉到 7、「待复查」从 12 涨到 14）。
 */
export function unresolvedTargets<T extends { key: string }>(
  targets: T[],
  checks: Array<{
    key: string;
    kind?: RefCheckKind;
    verdict: RefCheckVerdict;
    evidence?: { url: string; title: string } | null;
  }>,
  stillValid: (check: {
    kind?: RefCheckKind;
    evidence: { url: string; title: string } | null;
  }) => boolean = () => true,
): T[] {
  const done = new Set(
    checks
      .filter((c) => c.verdict === "matched" && stillValid({ kind: c.kind, evidence: c.evidence ?? null }))
      .map((c) => c.key),
  );
  return targets.filter((t) => !done.has(t.key));
}

/** 新结果能不能顶掉旧结果：旧的已找到出处而新的没有时不顶，其余都顶（含 matched 升级） */
export function shouldOverwrite(
  prev: RefCheckVerdict | null,
  next: RefCheckVerdict,
  prevStillValid = true,
): boolean {
  if (prev === null) return true;
  return !(prev === "matched" && prevStillValid && next !== "matched");
}

/**
 * 旧的「已找到公开出处」现在还站得住吗：按复查类型用不同门槛重算证据分级。
 * - 文号复查承诺的是「公开页面里出现了这个文号」，专业来源（税务实务库、法规 PDF）同样算出处，
 *   只有掉到「证据力弱」（门户首页、百科词条）才算失效；
 * - 引用替换承诺的是「找到官方原文」，因此必须仍是官方站点。
 * 不这样做的话，分级规则一旦收紧（例如把 index_pc.html 也认成门户入口页），
 * 上一轮误判的 matched 就会被不降级护栏永久锁死，再也纠正不回来。
 */
export function matchedStillValid(
  kind: RefCheckKind,
  evidence: { url: string; title: string } | null,
  gradeOf: (url: string, title: string) => { grade: string },
): boolean {
  if (!evidence || evidence.url === "") return false;
  const grade = gradeOf(evidence.url, evidence.title).grade;
  return kind === "citation" ? grade === "official" : grade !== "weak";
}

/** 保留旧证据时写进 note 的说明：把这次重试如实记下来，不藏失败 */
export function preservedNote(prevNote: string, next: RefCheckVerdict, checkedAt: string): string {
  const stamp = `${checkedAt.slice(0, 19).replace("T", " ")} 再次检索为「${REF_VERDICT_TEXT[next]}」，保留此前已找到的公开出处`;
  return prevNote.trim() === "" ? stamp : `${prevNote.trim()}；${stamp}`;
}

/** 修订指令的一条素材：一次已经出结果的复查记录 */
export type RevisionItem = {
  kind: RefCheckKind;
  verdict: RefCheckVerdict;
  /** 文号原文或引用标题 */
  text: string;
  /** 引用类复查的原地址（要被替换掉的那一条） */
  subjectUrl?: string;
  evidence: { title: string; url: string } | null;
  checkedAt: string;
};

/** 把复查记录整理成修订素材：检索失败的不进指令（重试即可，不该让模型据此改结论） */
export function toRevisionItems(
  checks: Array<{
    kind: RefCheckKind;
    verdict: RefCheckVerdict;
    text: string;
    subjectUrl?: string;
    evidence: { title: string; url: string } | null;
    checkedAt: string;
  }>,
): RevisionItem[] {
  return checks
    .filter((c) => c.verdict !== "error")
    .map((c) => ({
      kind: c.kind,
      verdict: c.verdict,
      text: c.text,
      subjectUrl: c.subjectUrl,
      evidence: c.evidence,
      checkedAt: c.checkedAt,
    }))
    .sort((a, b) => (a.kind === b.kind ? a.text.localeCompare(b.text) : a.kind === "docref" ? -1 : 1));
}

const stamp = (iso: string): string => (iso ? iso.replace("T", " ").slice(0, 16) : "");

/**
 * 把复查结果写成一条「续跑」修订指令：人工核对后提交给 Agent 重写依据与引用。
 * 平台不自动改写结论——指令只是填进续跑输入框，改不改、怎么改由税务师决定。
 * 没有可用素材时返回空串，调用方据此禁用按钮。
 */
export function buildRevisionInstruction(items: RevisionItem[]): string {
  if (items.length === 0) return "";
  const docMatched = items.filter((i) => i.kind === "docref" && i.verdict === "matched");
  const citMatched = items.filter((i) => i.kind === "citation" && i.verdict === "matched");
  const unresolved = items.filter((i) => i.verdict === "candidate" || i.verdict === "empty");
  const lines: string[] = [
    "请依据下列联网核对结果修订上一轮结论中的政策依据与联网引用；只改依据与引用部分，不要改动金额、测算过程、差异认定与结论意见。",
    "本轮只修订文字：不要重新调用解析、底稿生成、模板填列或底稿比对一类业务工具，也不要重新生成产物——已有工具结果与比对记录是上一轮的交付证据，重跑会把它们替换掉。",
    "",
  ];
  if (docMatched.length > 0) {
    lines.push("【补文号出处】以下政策文号已检索到公开原文，请在结论的政策依据处补上标题、URL 与检索时间：");
    for (const i of docMatched) {
      lines.push(`- ${i.text} → 《${i.evidence?.title ?? ""}》 ${i.evidence?.url ?? ""}（检索时间 ${stamp(i.checkedAt)}）`);
    }
    lines.push("");
  }
  if (citMatched.length > 0) {
    lines.push(
      "【替换弱证据引用】以下引用原先指向门户首页、百科词条或检索结果页，现已找到官方原文，请在结论正文与联网引用清单中替换：",
    );
    for (const i of citMatched) {
      lines.push(
        `- 「${i.text}」${i.subjectUrl ?? ""} → 《${i.evidence?.title ?? ""}》 ${i.evidence?.url ?? ""}（检索时间 ${stamp(
          i.checkedAt,
        )}）`,
      );
    }
    lines.push("");
  }
  if (unresolved.length > 0) {
    lines.push(
      "【标注未取得原文】以下项目联网复查后仍未取得政策原文，请在结论中明确写「未取得公开原文，仅作背景参考，不作为政策依据」，不得据此认定企业处理错误：",
    );
    for (const i of unresolved) {
      lines.push(
        `- ${i.text}${i.subjectUrl ? ` ${i.subjectUrl}` : ""}（复查判定：${REF_VERDICT_TEXT[i.verdict]}${
          i.evidence ? `，候选页《${i.evidence.title}》 ${i.evidence.url}，需人工确认` : ""
        }）`,
      );
    }
    lines.push("");
  }
  lines.push(
    "要求：",
    "1. 修订后重新输出完整结论（保留原有表格与 mermaid 图），不要只给差异；",
    "2. 每条联网引用都给出标题、URL 与检索时间；",
    "3. 不得新增未经工具计算或联网核验的政策口径、文号与金额。",
  );
  return lines.join("\n");
}

/** 修订素材计数：按钮文案与提示用 */
export function revisionCounts(items: RevisionItem[]): { total: number; replace: number; unresolved: number } {
  return {
    total: items.length,
    replace: items.filter((i) => i.verdict === "matched").length,
    unresolved: items.filter((i) => i.verdict === "candidate" || i.verdict === "empty").length,
  };
}
