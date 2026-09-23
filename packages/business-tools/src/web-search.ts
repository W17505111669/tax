import { Type } from "typebox";
import type { ToolDefinition } from "@tax/agent-core";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: "bing" | "baidu";
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

async function getHtml(url: string, signal?: AbortSignal): Promise<string> {
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
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

/** 实时联网检索：Bing 为主，失败或无结果时降级百度。 */
export async function searchWeb(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
  // 检索属于辅助能力：任一引擎异常都跳到下一引擎，全部失败则返回空结果，不让整个任务失败
  for (const engine of engineOrder()) {
    try {
      const html = await getHtml(searchUrl(engine, query), signal);
      const results = parseEngine(engine, html);
      if (results.length > 0) return results;
    } catch {
      // 尝试下一引擎
    }
  }
  return [];
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
    "实时联网检索公开网页（Bing 为主、百度兜底）。当留存备查资料缺失、业务口径不明、或需要同类公开业务案例与税务机关公开答复作为参考时调用。返回标题、URL、摘要与检索引擎。检索结果只能作为参考依据，不能替代客户原始资料。",
  promptSnippet: "search_public_cases: 联网检索公开业务案例与税务机关公开口径",
  parameters: Type.Object({
    query: Type.String({
      description: "检索词。建议「业务关键词 + 缺失资料名称 + 案例/口径」，例如：研发费用辅助账 缺失 税务 案例",
    }),
    missingMaterial: Type.Optional(Type.String({ description: "本次缺失的资料名称，便于组织结论" })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
  }),
  async execute(_toolCallId, params: { query: string; missingMaterial?: string; maxResults?: number }, signal) {
    const limit = params.maxResults ?? 5;
    const results = (await searchWeb(params.query, signal)).slice(0, limit);
    const retrievedAt = new Date().toISOString();
    const details = { query: params.query, missingMaterial: params.missingMaterial ?? null, retrievedAt, results };
    const text =
      results.length === 0
        ? `未检索到与「${params.query}」相关的公开结果。`
        : [
            `联网检索「${params.query}」共 ${results.length} 条公开结果（检索时间 ${retrievedAt}）：`,
            ...results.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   摘要: ${r.snippet || "(无摘要)"}`),
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
