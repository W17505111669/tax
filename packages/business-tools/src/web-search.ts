import { Type } from "typebox";
import type { ToolDefinition } from "@tax/agent-core";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: "bing" | "baidu";
  /** 与检索词命中的不同词元数（过滤阶段写入，供排序与界面显示） */
  relevance?: number;
  /** 命中的词元样例，最多 8 个 */
  matched?: string[];
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** 取页面：返回状态码、正文与最终地址，由调用方决定如何处理非 2xx 与验证页 */
async function getPage(
  url: string,
  signal?: AbortSignal,
): Promise<{ status: number; html: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
      signal: controller.signal,
      redirect: "follow",
    });
    return { status: res.status, html: await res.text(), finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function getHtml(url: string, signal?: AbortSignal): Promise<string> {
  const page = await getPage(url, signal);
  if (page.status < 200 || page.status >= 400) throw new Error(`HTTP ${page.status}`);
  return page.html;
}

function parseBing(html: string): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  for (const block of html.split('<li class="b_algo"').slice(1)) {
    const href = /<a[^>]+href="(https?:[^"]+)"/.exec(block);
    const title = /<h2[\s\S]{0,3000}?>([\s\S]{0,800}?)<\/h2>/.exec(block);
    const snippet = /<p[^>]*>([\s\S]{0,800}?)<\/p>/.exec(block);
    if (!href) continue;
    out.push({
      title: stripTags(title?.[1] ?? ""),
      url: decodeEntities(href[1]!),
      snippet: stripTags(snippet?.[1] ?? "").slice(0, 300),
      engine: "bing",
    });
    if (out.length >= 8) break;
  }
  return out;
}

function parseBaidu(html: string): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  for (const block of html.split('class="result').slice(1)) {
    const href = /<a[^>]+href="(https?:[^"]+)"/.exec(block);
    const title = /<h3[\s\S]{0,2000}?>([\s\S]{0,800}?)<\/h3>/.exec(block);
    const snippet = /class="c-abstract[^"]*"[\s\S]{0,40}>([\s\S]{0,800}?)<\/(?:span|div)>/.exec(block);
    if (!href || !title) continue;
    out.push({
      title: stripTags(title[1]!),
      url: decodeEntities(href[1]!),
      snippet: stripTags(snippet?.[1] ?? "").slice(0, 300),
      engine: "baidu",
    });
    if (out.length >= 8) break;
  }
  return out;
}

type SearchEngine = "bing" | "baidu";

/** 检索引擎顺序可用环境变量 TAXAI_SEARCH_ENGINES 调整，默认 bing,baidu。 */
function engineOrder(): SearchEngine[] {
  const raw = process.env.TAXAI_SEARCH_ENGINES ?? "bing,baidu";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SearchEngine => s === "bing" || s === "baidu");
  return list.length > 0 ? list : ["bing", "baidu"];
}

function searchUrl(engine: SearchEngine, query: string): string {
  const q = encodeURIComponent(query);
  return engine === "bing"
    ? `https://www.bing.com/search?q=${q}&setlang=zh-hans`
    : `https://www.baidu.com/s?wd=${q}`;
}

function parseEngine(engine: SearchEngine, html: string): WebSearchResult[] {
  return engine === "bing" ? parseBing(html) : parseBaidu(html);
}

/* --------------------------------------------------------------------------
 * 检索结果可信度：相关度门槛 + 入口页过滤 + 验证页识别
 *
 * 实测问题：检索「土地增值税清算 建安成本 合同金额与发票金额不一致」时，引擎返回的
 * 是「土地（自然经济综合体）_百度百科」「自然资源部首页」这类与检索词无关的条目，
 * 这些地址会顺着工具结果进入结论的联网引用，直接拉低交付材料的可信度。
 * 因此解析之后再加一道纯函数过滤：宁可如实返回「未检索到」，也不把无关结果交给模型。
 * -------------------------------------------------------------------------- */

/** 切分时忽略的虚词，避免「的相关案例」这类片段制造假命中 */
const STOP_TOKENS = new Set([
  "如何", "什么", "怎么", "是否", "以及", "相关", "有关", "进行", "需要", "可以", "关于", "这个", "那个",
]);

/** 检索词切分：ASCII 词与数字按整词，中文按二元组（含停用词过滤） */
export function queryTokens(query: string): string[] {
  const out = new Set<string>();
  for (const w of query.match(/[A-Za-z0-9]{2,}/g) ?? []) out.add(w.toLowerCase());
  for (const run of query.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bi = run.slice(i, i + 2);
      if (!STOP_TOKENS.has(bi)) out.add(bi);
    }
  }
  return [...out];
}

function safeDecode(u: string): string {
  try {
    return decodeURIComponent(u);
  } catch {
    return u;
  }
}

export function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 命中检索词的不同词元数（标题、摘要、解码后的 URL 任一命中即算一个） */
export function relevanceHits(
  query: string,
  r: { title: string; url: string; snippet: string },
): { hits: number; matched: string[] } {
  const hay = `${r.title}\n${r.snippet}\n${safeDecode(r.url)}`.toLowerCase();
  const matched = queryTokens(query).filter((t) => hay.includes(t));
  return { hits: matched.length, matched };
}

/** 权威域名：政府与税务机关站点。命中时相关度门槛降 1，让短检索词也能留下官方原文 */
export function isAuthoritativeUrl(raw: string): boolean {
  const host = hostOf(raw);
  return host === null ? false : host.endsWith("gov.cn") || host.endsWith("gov.hk") || host.endsWith("chinatax.org");
}

const ENTRY_LAST_SEGMENT = /^(index|main|home|default|login|logout|register|search)(\.[a-z]{2,5})?$/i;

/**
 * 入口页：站点首页、单级栏目页、登录/检索页。
 * 这类地址没有具体文件内容，作为政策依据引用等于没有依据，一律过滤。
 */
export function isEntryPage(raw: string): boolean {
  let path: string;
  try {
    path = new URL(raw).pathname;
  } catch {
    return false;
  }
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return true;
  const last = trimmed.split("/").pop() ?? "";
  if (ENTRY_LAST_SEGMENT.test(last)) return true;
  // 单级路径且没有文件扩展名（如 /guoqing）多为门户栏目页
  return !trimmed.slice(1).includes("/") && !/\.[a-z]{2,5}$/i.test(last);
}

/** 百科 / 知识库词条：可作背景了解，不能替代政策原文（界面按「证据力弱」标注） */
export function isEncyclopediaUrl(raw: string): boolean {
  const host = hostOf(raw);
  if (!host) return false;
  return (
    host.startsWith("baike.") ||
    host.startsWith("wiki.") ||
    host.endsWith("wikipedia.org") ||
    host.endsWith("mbalib.com") ||
    host.endsWith("baike.com")
  );
}

export type DropReason = "entry" | "irrelevant" | "duplicate";

export type DroppedResult = { title: string; url: string; reason: DropReason; detail: string };

export type FilteredSearch = { kept: WebSearchResult[]; dropped: DroppedResult[] };

/** 相关度门槛：命中少于该词元数的结果视为无关。可用 TAXAI_SEARCH_MIN_RELEVANCE 调整 */
export function minRelevanceScore(): number {
  const n = Number.parseInt(process.env.TAXAI_SEARCH_MIN_RELEVANCE ?? "2", 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

/** 过滤：重复地址与入口页直接丢，相关度不足按门槛丢；保留结果按命中数降序 */
export function filterSearchResults(
  query: string,
  results: WebSearchResult[],
  minScore: number = minRelevanceScore(),
): FilteredSearch {
  const kept: WebSearchResult[] = [];
  const dropped: DroppedResult[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const key = r.url.replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) {
      dropped.push({ title: r.title, url: r.url, reason: "duplicate", detail: "同一地址重复出现" });
      continue;
    }
    seen.add(key);
    if (isEntryPage(r.url)) {
      dropped.push({ title: r.title, url: r.url, reason: "entry", detail: "站点首页或栏目入口，没有具体文件内容" });
      continue;
    }
    const need = isAuthoritativeUrl(r.url) ? Math.max(1, minScore - 1) : minScore;
    const rel = relevanceHits(query, r);
    if (rel.hits < need) {
      dropped.push({
        title: r.title,
        url: r.url,
        reason: "irrelevant",
        detail: `与检索词只命中 ${rel.hits} 个词元，低于门槛 ${need}`,
      });
      continue;
    }
    kept.push({ ...r, relevance: rel.hits, matched: rel.matched.slice(0, 8) });
  }
  kept.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
  return { kept, dropped };
}

const BLOCK_MARKERS: Array<[RegExp, string]> = [
  [/百度安全验证/, "百度安全验证"],
  [/wappass\.baidu\.com/, "百度安全验证跳转"],
  [/<title[^>]*>[^<]{0,40}(安全验证|验证码|人机验证)/, "搜索引擎验证页"],
  [/Access Denied|Request Denied|Permission Denied/i, "访问被拒绝"],
  [/unusual traffic|are you a robot|请完成安全验证|请输入验证码/i, "反爬验证"],
];

/** 识别「拿到的不是检索结果页」：验证页 / 反爬页。只看前 4000 字，避免误判正文里的词 */
export function detectBlockedPage(html: string): string | null {
  const head = html.slice(0, 4000);
  for (const [re, label] of BLOCK_MARKERS) if (re.test(head)) return label;
  return null;
}

export type SearchAttemptStatus = "ok" | "irrelevant" | "empty" | "blocked" | "error";

export type SearchAttempt = {
  engine: SearchEngine;
  status: SearchAttemptStatus;
  /** 引擎页面解析出的结果条数 */
  fetched: number;
  /** 过滤后保留的条数 */
  kept: number;
  /** 过滤掉的条数 */
  dropped: number;
  httpStatus: number | null;
  note: string;
};

export type DetailedSearch = { results: WebSearchResult[]; attempts: SearchAttempt[]; minScore: number };

/**
 * 实时联网检索（带过程记录）：Bing 为主，请求失败、触发验证页、解析为空、
 * 或结果全部与检索词无关时降级下一引擎；全部不可用则返回空结果并如实记录原因。
 */
export async function searchWebDetailed(query: string, signal?: AbortSignal): Promise<DetailedSearch> {
  const minScore = minRelevanceScore();
  const attempts: SearchAttempt[] = [];
  for (const engine of engineOrder()) {
    const base = { engine, fetched: 0, kept: 0, dropped: 0, httpStatus: null as number | null };
    try {
      const page = await getPage(searchUrl(engine, query), signal);
      base.httpStatus = page.status;
      if (page.status < 200 || page.status >= 400) {
        attempts.push({ ...base, status: "error", note: `HTTP ${page.status}` });
        continue;
      }
      const blocked = detectBlockedPage(page.html);
      if (blocked) {
        attempts.push({ ...base, status: "blocked", note: blocked });
        continue;
      }
      const parsed = parseEngine(engine, page.html);
      base.fetched = parsed.length;
      if (parsed.length === 0) {
        attempts.push({ ...base, status: "empty", note: "页面未解析出结果条目" });
        continue;
      }
      const filtered = filterSearchResults(query, parsed, minScore);
      base.kept = filtered.kept.length;
      base.dropped = filtered.dropped.length;
      if (filtered.kept.length === 0) {
        const entry = filtered.dropped.filter((d) => d.reason === "entry").length;
        attempts.push({
          ...base,
          status: "irrelevant",
          note: `${parsed.length} 条结果与检索词无关${entry > 0 ? `（其中入口页 ${entry} 条）` : ""}`,
        });
        continue;
      }
      attempts.push({ ...base, status: "ok", note: `保留 ${filtered.kept.length} 条，过滤 ${filtered.dropped.length} 条` });
      return { results: filtered.kept, attempts, minScore };
    } catch (err) {
      attempts.push({ ...base, status: "error", note: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results: [], attempts, minScore };
}

/** 实时联网检索：只返回过滤后的可用结果（沿用既有调用方签名） */
export async function searchWeb(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
  return (await searchWebDetailed(query, signal)).results;
}

const ENGINE_LABEL: Record<SearchEngine, string> = { bing: "Bing", baidu: "百度" };

const STATUS_LABEL: Record<SearchAttemptStatus, string> = {
  ok: "可用",
  irrelevant: "结果与检索词无关",
  empty: "未解析出结果",
  blocked: "触发安全验证",
  error: "请求失败",
};

/** 引擎尝试过程的人类可读说明：没有可用结果时用它如实交代原因 */
export function describeAttempts(attempts: SearchAttempt[]): string {
  if (attempts.length === 0) return "未尝试任何检索引擎";
  return attempts
    .map((a) => `${ENGINE_LABEL[a.engine]} ${STATUS_LABEL[a.status]}${a.note ? `（${a.note}）` : ""}`)
    .join("；");
}

function assertSafeUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`仅支持 http/https 链接: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(host)
  ) {
    throw new Error(`禁止访问内网地址: ${raw}`);
  }
  return url;
}

function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]{0,200}?)<\/title>/.exec(html);
  const body = /<body[\s\S]*?>([\s\S]*)<\/body>/.exec(html);
  let content = body?.[1] ?? html;
  content = content
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, " ");
  return { title: stripTags(title?.[1] ?? ""), text: stripTags(content) };
}

/**
 * 公开案例 / 公开文件检索工具。
 * 用于资料缺失时补充公开业务案例、税务机关公开口径与同类处理参考。
 */
export const searchPublicCasesTool: ToolDefinition = {
  name: "search_public_cases",
  label: "公开案例联网检索",
  description:
    "实时联网检索公开网页（Bing 为主、百度兜底）。当留存备查资料缺失、业务口径不明、或需要同类公开业务案例与税务机关公开答复作为参考时调用。返回标题、URL、摘要、相关度与检索引擎。结果已按检索词相关度过滤，站点首页/栏目入口与无关条目会被丢弃，因此可能返回「未检索到」并附带各引擎的失败原因；此时请换更具体的检索词（政策文号 + 业务关键词）重试，或在结论中如实说明资料缺失，不得据此编造政策口径。检索结果只能作为参考依据，不能替代客户原始资料。",
  promptSnippet:
    "search_public_cases: 联网检索公开业务案例与税务机关公开口径（结果按相关度过滤，无关条目与门户首页会被丢弃）",
  parameters: Type.Object({
    query: Type.String({
      description: "检索词。建议「业务关键词 + 缺失资料名称 + 案例/口径」，例如：研发费用辅助账 缺失 税务 案例",
    }),
    missingMaterial: Type.Optional(Type.String({ description: "本次缺失的资料名称，便于组织结论" })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
  }),
  async execute(_toolCallId, params: { query: string; missingMaterial?: string; maxResults?: number }, signal) {
    const limit = params.maxResults ?? 5;
    const found = await searchWebDetailed(params.query, signal);
    const results = found.results.slice(0, limit);
    const retrievedAt = new Date().toISOString();
    const droppedTotal = found.attempts.reduce((n, a) => n + a.dropped, 0);
    const details = {
      query: params.query,
      missingMaterial: params.missingMaterial ?? null,
      retrievedAt,
      minRelevance: found.minScore,
      dropped: droppedTotal,
      attempts: found.attempts,
      results,
    };
    const text =
      results.length === 0
        ? [
            `未检索到与「${params.query}」相关的可用公开结果。`,
            `引擎尝试：${describeAttempts(found.attempts)}。`,
            "处理方式：换用更具体的检索词（政策文号 + 业务关键词）重试；仍无结果时在结论中如实说明「资料缺失且未取得公开依据」，不得据此编造政策口径。",
          ].join("\n")
        : [
            `联网检索「${params.query}」共 ${results.length} 条可用公开结果（检索时间 ${retrievedAt}，引擎 ${
              results[0] ? ENGINE_LABEL[results[0].engine] : "-"
            }，相关度门槛 ${found.minScore} 个词元${droppedTotal > 0 ? `，已过滤 ${droppedTotal} 条无关或入口页结果` : ""}）：`,
            ...results.map(
              (r, i) =>
                `${i + 1}. ${r.title}\n   URL: ${r.url}\n   相关度: 命中 ${r.relevance ?? 0} 个检索词元${
                  isEncyclopediaUrl(r.url) ? "（百科词条，仅作背景参考，不能替代政策原文）" : ""
                }\n   摘要: ${r.snippet || "(无摘要)"}`,
            ),
          ].join("\n");
    return { content: [{ type: "text", text }], details };
  },
};

/** 读取指定公开网页正文，用于把检索到的案例文件读进上下文。 */
export const fetchPublicDocumentTool: ToolDefinition = {
  name: "fetch_public_document",
  label: "公开网页正文读取",
  description:
    "读取一个公开 http/https 网页的正文文本（自动去除导航与脚本），用于阅读 search_public_cases 检索到的案例或政策文件。禁止访问内网地址。返回标题与截断后的正文。",
  promptSnippet: "fetch_public_document: 读取公开网页正文",
  parameters: Type.Object({
    url: Type.String({ description: "要读取的公开网页 URL" }),
    maxChars: Type.Optional(Type.Integer({ minimum: 500, maximum: 20000 })),
  }),
  async execute(_toolCallId, params: { url: string; maxChars?: number }, signal) {
    const url = assertSafeUrl(params.url);
    const html = await getHtml(url.toString(), signal);
    const { title, text } = htmlToText(html);
    const maxChars = params.maxChars ?? 6000;
    const body = text.slice(0, maxChars);
    const details = { url: url.toString(), title, charCount: text.length, truncated: text.length > maxChars, retrievedAt: new Date().toISOString() };
    const content = `网页标题：${title || "(无)"}\nURL：${url}\n正文（${body.length} 字${text.length > maxChars ? "，已截断" : ""}）：\n${body}`;
    return { content: [{ type: "text", text: content }], details };
  },
};

export const sharedWebTools = [searchPublicCasesTool, fetchPublicDocumentTool];
