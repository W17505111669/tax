/**
 * 联网检索留痕：把「检索过什么、留下了什么」写成可核对的结构。
 *
 * 两类工具留存能力不同，界面必须如实区分：
 * - 自建工具（search_public_cases / fetch_public_document）与社区扩展的 fetch_content 会留下标题与 URL，
 *   可以直接生成联网引用清单；
 * - 社区扩展 web_search 只把查询词、条数、检索 ID、provider 等元数据写回工具结果，
 *   命中了多少条、都是哪些页面并没有落库，因此「没有引用清单」不等于「没有联网检索」。
 *
 * 纯函数，便于 apps/api/scripts/verify-search-evidence.ts 直接校验，
 * 前端引用清单与交付包 manifest 走查共用同一份提取逻辑，避免两处口径漂移。
 */

/** 参与统计的联网检索/读取工具（与时间线、进度推导使用同一批名字） */
export const SEARCH_TOOL_NAMES = new Set([
  "web_search",
  "search_public_cases",
  "fetch_content",
  "fetch_public_document",
  "get_search_content",
]);

export type SearchCall = { toolName: string; result: unknown };

export type ExtractedCitation = { title: string; url: string; via: string };

export type SearchEvidence = {
  /** 联网检索/读取类工具调用总数 */
  calls: number;
  /** 其中留下了可引用 URL 的调用数 */
  withUrls: number;
  /** 只留下查询元数据、无法列出来源的调用数 */
  metadataOnly: number;
  /** 元数据检索自报的命中条数合计（扩展写回的 totalResults） */
  reportedResults: number;
  /** 去重后的检索词（最多 12 条，按出现顺序） */
  queries: string[];
  /** 检索 provider（如 exa） */
  providers: string[];
  /** 用过的工具名 */
  tools: string[];
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function numOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** 从一次工具调用的结果里取出可引用的 URL 与标题（覆盖自建工具与扩展 fetch_content 两种形状） */
export function urlsOfCall(toolName: string, result: unknown): Array<{ url: string; title: string }> {
  const r = asRecord(result);
  if (!r) return [];
  const out: Array<{ url: string; title: string }> = [];
  const push = (url: unknown, title: unknown): void => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
    out.push({ url, title: typeof title === "string" && title.trim() !== "" ? title.trim() : url });
  };
  // search_public_cases：results[] 带 title/url
  if (Array.isArray(r.results)) {
    for (const item of r.results) {
      const o = asRecord(item);
      if (o) push(o.url, o.title);
    }
  }
  // fetch_public_document：单条 url + title
  push(r.url, r.title);
  // fetch_content：urls[] + 单个 title（多地址时标题不可归属，退回用地址本身）
  const urls = strArray(r.urls);
  const sharedTitle = urls.length === 1 && typeof r.title === "string" ? r.title : null;
  for (const u of urls) push(u, sharedTitle);
  void toolName;
  return out;
}

/** 检索词与 provider：来自自建工具的 query 与扩展 web_search 的 queries / queryProviders */
export function queriesOfCall(result: unknown): { queries: string[]; providers: string[] } {
  const r = asRecord(result);
  if (!r) return { queries: [], providers: [] };
  const queries = new Set<string>();
  const providers = new Set<string>();
  if (typeof r.query === "string" && r.query.trim() !== "") queries.add(r.query.trim());
  for (const q of strArray(r.queries)) if (q.trim() !== "") queries.add(q.trim());
  if (Array.isArray(r.queryProviders)) {
    for (const item of r.queryProviders) {
      const o = asRecord(item);
      if (!o) continue;
      if (typeof o.query === "string" && o.query.trim() !== "") queries.add(o.query.trim());
      for (const p of strArray(o.providers)) if (p.trim() !== "") providers.add(p.trim());
    }
  }
  return { queries: [...queries], providers: [...providers] };
}

/** 引用清单上限：界面胶囊与整页 MD 都按这个数量截断 */
export const CITATION_LIMIT = 20;

/** 合并后的引用清单上限（工具留存 + 结论正文） */
export const MERGED_CITATION_LIMIT = 24;

/**
 * 统计口径：不截断。
 *
 * 上面两个上限是**界面**需要（胶囊与整页 MD 不可能列几百条），但分级构成、修订前后对比这类
 * 度量必须数全量：截断窗口会随结论长度挪动，构成因此凭空涨跌。实测一个任务本轮真加了 2 条
 * 官方原文（全量 official 11 → 13），却因为结论变长、前 20 条窗口整体挪动，被算成 official
 * 11 → 10，判为「证据质量退步，请核对本次修订」，把一条假警报送进了交付自检。
 */
export const UNCAPPED = Number.POSITIVE_INFINITY;

/** 结论正文里被引用的地址来源标记 */
export const CONCLUSION_VIA = "conclusion";

const OPAQUE_SEGMENT = /^(index|content|main|default|home|t?\d+|details\d*)(\.[a-z]{2,5})?$/i;

/** 没有链接文字时给个可读标签：末段是有意义的文件名就用它，否则用域名 */
export function labelFromUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const seg = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    if (seg !== "" && seg.length >= 4 && !OPAQUE_SEGMENT.test(seg)) return seg.slice(0, 40);
    return u.hostname;
  } catch {
    return raw;
  }
}

/**
 * 从结论正文里提取被引用的 URL。
 * 只从工具结果取引用会漏掉一大半：实测 24 个任务的结论正文里有 50 条 URL，
 * 只有 18 条来自工具留存，漏掉的 32 条里包含政策法规库等最该被核验的官方原文
 * （政策快照工具给出的文号链接，以及修订后由 Agent 直接写进正文的替代来源）。
 * markdown 链接优先取链接文字作标题，裸链接用 labelFromUrl 兜底。
 */
export function extractTextCitations(text: string, limit: number = CITATION_LIMIT): ExtractedCitation[] {
  const out: ExtractedCitation[] = [];
  if (!text) return out;
  const seen = new Set<string>();
  const push = (url: string, title: string): void => {
    if (out.length >= limit) return;
    // 去掉结尾的中英文标点与括号，避免把句读当成地址的一部分
    const clean = url.replace(/[)\]>"'）】\],.;:!?，。；：！？、]+$/, "");
    if (!/^https?:\/\//i.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    out.push({
      title: title.trim() === "" ? labelFromUrl(clean) : title.trim().slice(0, 120),
      url: clean,
      via: CONCLUSION_VIA,
    });
  };
  for (const m of text.matchAll(/\[([^\]]{0,120})\]\((https?:\/\/[^)\s]+)\)/g)) push(m[2] ?? "", m[1] ?? "");
  for (const m of text.matchAll(/https?:\/\/[^\s)\]>"'|，。；、]+/g)) push(m[0], "");
  return out.slice(0, limit);
}

/** 合并两个来源：同一地址只留一条，标题优先用工具留存的（更完整），来源标记保留在 via */
export function mergeCitations(
  fromTools: ExtractedCitation[],
  fromText: ExtractedCitation[],
  limit: number = MERGED_CITATION_LIMIT,
): ExtractedCitation[] {
  const out: ExtractedCitation[] = [];
  const seen = new Set<string>();
  for (const c of [...fromTools, ...fromText]) {
    if (out.length >= limit) break;
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}

/** 单次检索被过滤掉的条数：自建工具把 details.dropped 落库，用于统计「拦下多少无关结果」 */
export function droppedOfCall(result: unknown): number {
  return numOf(asRecord(result)?.dropped);
}

export type SearchFiltering = { kept: number; dropped: number };

/** 全部检索调用留下的可用来源数与被过滤条数合计（平台看板与验证脚本共用） */
export function searchFiltering(calls: SearchCall[]): SearchFiltering {
  const out: SearchFiltering = { kept: 0, dropped: 0 };
  for (const c of calls) {
    if (!SEARCH_TOOL_NAMES.has(c.toolName)) continue;
    out.kept += urlsOfCall(c.toolName, c.result).length;
    out.dropped += droppedOfCall(c.result);
  }
  return out;
}

/** 从工具调用里提取联网引用（按 URL 去重，保留首次出现的标题与来源工具） */
export function extractCitations(calls: SearchCall[], limit: number = CITATION_LIMIT): ExtractedCitation[] {
  const out: ExtractedCitation[] = [];
  for (const c of calls) {
    if (!SEARCH_TOOL_NAMES.has(c.toolName)) continue;
    for (const u of urlsOfCall(c.toolName, c.result)) {
      if (out.some((x) => x.url === u.url)) continue;
      out.push({ title: u.title, url: u.url, via: c.toolName });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 联网检索留痕汇总：有来源的调用、只留元数据的调用、自报命中数、检索词与 provider */
export function searchEvidence(calls: SearchCall[]): SearchEvidence {
  const ev: SearchEvidence = {
    calls: 0,
    withUrls: 0,
    metadataOnly: 0,
    reportedResults: 0,
    queries: [],
    providers: [],
    tools: [],
  };
  const queries: string[] = [];
  const providers = new Set<string>();
  const tools = new Set<string>();
  for (const c of calls) {
    if (!SEARCH_TOOL_NAMES.has(c.toolName)) continue;
    ev.calls += 1;
    tools.add(c.toolName);
    const urls = urlsOfCall(c.toolName, c.result);
    if (urls.length > 0) ev.withUrls += 1;
    else ev.metadataOnly += 1;
    const r = asRecord(c.result);
    ev.reportedResults += numOf(r?.totalResults);
    const q = queriesOfCall(c.result);
    for (const x of q.queries) if (!queries.includes(x)) queries.push(x);
    for (const p of q.providers) providers.add(p);
  }
  ev.queries = queries.slice(0, 12);
  ev.providers = [...providers];
  ev.tools = [...tools];
  return ev;
}

/**
 * 「没有引用清单」的如实说明：区分「根本没联网检索」与「检索过但扩展只留元数据」。
 * 返回 null 表示不需要说明（已经有引用清单，或压根没检索过——后者由交付自检按提醒处理）。
 */
export function searchEvidenceNote(ev: SearchEvidence, citations: number): string | null {
  if (citations > 0 || ev.calls === 0 || ev.metadataOnly === 0) return null;
  const tools = ev.tools.join(" / ");
  const reported = ev.reportedResults > 0 ? `，扩展自报命中 ${ev.reportedResults} 条` : "";
  const qs = ev.queries.length > 0 ? `\n检索词：${ev.queries.slice(0, 5).join("；")}` : "";
  return `本任务执行过 ${ev.calls} 次联网检索（${tools}${reported}），但检索扩展只把查询元数据写回工具结果，没有留存标题与 URL，因此无法生成引用清单。请在结论中附检索词与检索时间，或改用 search_public_cases 检索以留存来源。${qs}`;
}
