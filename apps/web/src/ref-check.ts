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
  if (t.kind === "citation") return stripSiteSuffix(t.text);
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
  const full = buildRefQuery(t);
  if (t.kind === "citation") return full === "" ? [] : [full];
  const prefix = refPrefix(t.context ?? "", t.text);
  const tight = `${prefix}${t.text.replace(/\s+/g, "")}`.trim();
  return [full, tight].filter((q, i, arr) => q !== "" && arr.indexOf(q) === i);
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
    const better = outcome.hits.find((h) => gradeCitation(h.url, h.title).grade === "official");
    if (better) {
      return { verdict: "matched", evidence: toEvidence(better), note: "检索到政府或税务机关站点的具体文件页" };
    }
    const best = bestHit(outcome.hits);
    return {
      verdict: "candidate",
      evidence: best ? toEvidence(best) : null,
      note: "未检索到官方原文，仅给出相关度最高的候选页",
    };
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
