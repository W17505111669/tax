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

import { stripInlineMarkdown } from "./md-text.ts";

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

/**
 * 标题去记号：工具留存与结论正文两条提取路径共用。
 *
 * 引用胶囊上的标题是从 Markdown 里抠出来的，实测出现过两类脏东西：
 * 写成 [`…content.html`](url) 的行内代码把反引号带进了标题，写成 [**官方解读**](url)
 * 的粗体把 `**` 带进了标题——胶囊只有 260px 宽、还要 truncate，记号占了字宽还看不出是标题。
 * 空标题退回 fallback（工具路径用地址本身，正文路径用 labelFromUrl），口径与改动前一致。
 */
function plainTitle(raw: unknown, fallback: string): string {
  const t = typeof raw === "string" ? stripInlineMarkdown(raw).replace(/\s+/g, " ").trim() : "";
  return t === "" ? fallback : t.slice(0, 120);
}

/** 从一次工具调用的结果里取出可引用的 URL 与标题（覆盖自建工具与扩展 fetch_content 两种形状） */
export function urlsOfCall(toolName: string, result: unknown): Array<{ url: string; title: string }> {
  const r = asRecord(result);
  if (!r) return [];
  const out: Array<{ url: string; title: string }> = [];
  const push = (url: unknown, title: unknown): void => {
    if (typeof url !== "string") return;
    // 工具结果里的地址同样可能带着从页面正文抠出来时黏上的中文尾巴（实测有过
    // 「…guoshuifa200991.pdf（检索时间 2026-09-29」）。清理规则收在入口处、两条提取路径共用，
    // 否则假地址会进引用清单：核验必然 404，还会把同一个原文页重复计成两条。
    const clean = cleanBareUrl(url);
    if (!/^https?:\/\//i.test(clean)) return;
    out.push({ url: clean, title: plainTitle(title, clean) });
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

/**
 * 留存正文里的来源行：`Source: <标题> (<http(s) 地址>)`，独占一行。
 *
 * web_search 这类扩展工具把每条结果的地址写在结果正文末尾的这一行里，而它的结构化字段
 *（queries / queryProviders / searchId）只有检索词，没有地址。此前整条链路只认结构化字段
 *（urlsOfCall 上面那三种形状），于是这些明明已经抓在手上的页面地址一个都没被用出来——
 * 实测「仅正文提到」2 处里有 1 处因此点不开原文，功能等于白做。
 *
 * 判据从严：只认整行严格匹配、地址必须是 http(s)、再过一遍 cleanBareUrl；认不出一条也不给。
 * 这里不做任何「大概是这个页面」的推断，猜出来的地址比空地址更坏（核验必然 404，还会把
 * 复核人引到无关页面上去）。
 */
export function retainedSourceLines(
  body: string,
): Array<{ url: string; title: string; lineStart: number; lineEnd: number }> {
  const out: Array<{ url: string; title: string; lineStart: number; lineEnd: number }> = [];
  for (const m of body.matchAll(/^[ \t]*Source:[ \t]*(.+?)[ \t]*\((https?:\/\/[^()\s]+)\)[ \t]*$/gm)) {
    const url = cleanBareUrl(m[2] ?? "");
    if (!/^https?:\/\//i.test(url)) continue;
    const start = m.index ?? 0;
    out.push({
      url,
      title: plainTitle(m[1] ?? "", url),
      lineStart: start,
      lineEnd: start + (m[0]?.length ?? 0),
    });
  }
  return out;
}

/**
 * 正文里某个位置属于哪一条结果：web_search 的留存正文是「结果标题 + 摘要 … 换行 … Source: 标题 (地址)」
 * 一条接一条，所以一条结果的来源行在它**后面**，不在前面。
 *
 * 方向不能反：实测那处「2023年第8号」往前找会拿到广东税务的解读页，而命中上下文写的是
 * 「……公告 - 中瑞财税信息网站 …… 注：根据 2023.05.26 国家税务总局公告2023年第8号……本文第一条失效」，
 * 归属的其实是中瑞财税那一页。往前找就是给错链接。
 *
 * 归属不确定时返回 null，两种情况：命中落在小节标题行里（`## Query: "……"` 是检索词，不属于任何页面），
 * 或命中与来源行之间隔了新的小节标题（说明跨段了，往后那条来源行不是这一段的收尾）。
 */
export function retainedSourceAt(body: string, offset: number): { url: string; title: string } | null {
  const lines = retainedSourceLines(body);
  if (lines.length === 0 || offset < 0 || offset > body.length) return null;
  const lineStart = body.lastIndexOf("\n", offset) + 1;
  const nl = body.indexOf("\n", offset);
  const own = body.slice(lineStart, nl < 0 ? body.length : nl);
  if (/^[ \t]*##/.test(own)) return null;
  const owner = lines.find((l) => l.lineEnd >= offset);
  if (!owner) return null;
  if (/^[ \t]*##/m.test(body.slice(offset, owner.lineStart))) return null;
  return { url: owner.url, title: owner.title };
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

/**
 * 地址终止符：全角标点、中文标点与弯引号破折号。
 *
 * 这些字符出现在 URL 里必须百分号转义，所以裸写出来就说明地址到此为止。实测结论正文里的
 * 「…content.html（检索时间 2026-09-29」「…content.html／2026-09-29」被整段当成了地址，
 * 后果有三层：核验必然 404、同一个原文页被当成两条独立引用重复计数、路径不以 /content.html
 * 结尾于是分级认不出它是政策法规库原文页。
 *
 * 不按「非 ASCII」一刀切：路径里带未转义中文的地址是真实存在的（`…/p/研发费用指引.html`），
 * 浏览器与文档里都这么写，切掉就把好地址截坏了。汉字本身不是终止符，只有标点才是。
 */
const URL_TERMINATOR = /[\u2013\u2014\u2018-\u201F\u2026\u3000-\u303F\uFF00-\uFFEF]/;

/**
 * 从正文里切出一条干净的裸地址：先在全角/中文标点处截断，再去掉结尾的半角标点与括号。
 *
 * 提取与验证脚本共用这一份实现。此前验证脚本自己抄了一套正则，本轮修正提取口径后两边就对不上了
 *（20 项失败，全是「结论正文的 URL 未进入引用清单」）——同一件事写两遍，迟早漂。
 */
export function cleanBareUrl(raw: string): string {
  const cut = raw.search(URL_TERMINATOR);
  const head = cut === -1 ? raw : raw.slice(0, cut);
  // 反引号与星号也算结尾噪声：结论里把地址写成行内代码或粗体时（`https://…` / **https://…**），
  // 记号会黏在地址尾巴上。实测「…c5185946/content.html`」就是这么进引用清单的——标题难看是小事，
  // 带着反引号的地址点开必然 404，链接核验也会白跑一次。
  return head.replace(/[)\]>"'`*）】\],.;:!?，。；：！？、]+$/, "");
}

/** 作废交代的判定窗口（字）。实测「原引用的」距地址 22 字，40 字够覆盖且不误伤密集表格 */
const RETIRE_WINDOW = 40;

/**
 * 只会「引出那一条已作废地址」的说法（往前看，即写在地址**前面**的）。
 *
 * 词表刻意收窄：「已判定失效」「不再作为」「已替换为」这类是跟在作废地址**后面**、或出现在
 * 替代地址**前面**的，收进来会把刚换上的有效地址一起误杀（第一版正是这么错的，测试当场抓出来）。
 * 带冒号的那几个只在「已失效：…」这种清单引导语里成立，因此连冒号一起收。
 */
const RETIRED_MARKERS = ["原引用", "原地址", "原链接", "原网址", "已失效：", "失效地址", "已作废："];

/**
 * 写在地址**后面**的作废交代。与前面的词表分开，因为方向决定了会不会误杀：
 * 「已替换为」出现在替代地址前面，往前看时收进来会杀掉刚换上的有效地址；往后看时它恰恰
 * 是在交代旧地址的下场，必须收。同理「不再引用」「不再作为」。
 * 不收裸「失效」二字：实测有「其他页面存在同类失效风险」这种泛泛说法，收了会误伤。
 */
const RETIRED_AFTER_MARKERS = ["已失效", "已作废", "不再引用", "不再作为", "已替换为", "4xx"];

/**
 * 这处地址出现是不是在交代「它已作废」。
 *
 * 模型按修订指令撤下失效链接后，会留下作废交代。这句交代是好事，但里面的地址若仍被当成当前
 * 引用，失效链接就永远挂在待办与交付自检里——修一次报一次，形成解不掉的假警报。
 *
 * 交代可能写在地址前面，也可能写在后面：实测「失效地址说明：原引用的《X》 https://… 经核验
 * 返回 4xx」是前置，而替换映射表那一行「| 19 | X https://…c5185946/content.html（服务端 GET
 * 返回 4xx，地址已失效） | 替代标题 | https://gov.cn/… |」是后置。只往前看会漏掉后者，于是
 * 已经换好的地址又被列进修订指令，模型白跑一轮。
 *
 * @param urlLength 地址本身的长度，用于定位「地址之后」的起点；缺省 0 表示只往前看。
 */
export function isRetiredMention(text: string, index: number, urlLength = 0): boolean {
  const before = text.slice(Math.max(0, index - RETIRE_WINDOW), index);
  if (RETIRED_MARKERS.some((w) => before.includes(w))) return true;
  if (urlLength <= 0) return false;
  // 往后看的范围必须收得住，否则会把下一行、下一条引用的说明算到这条头上：
  // 遇到下一个地址、换行，或超出窗口即止。
  const from = index + urlLength;
  const nextUrl = text.indexOf("http", from);
  const nextLine = text.indexOf("\n", from);
  const stop = Math.min(
    from + RETIRE_WINDOW,
    nextUrl < 0 ? Number.MAX_SAFE_INTEGER : nextUrl,
    nextLine < 0 ? Number.MAX_SAFE_INTEGER : nextLine,
  );
  const after = text.slice(from, stop);
  return RETIRED_AFTER_MARKERS.some((w) => after.includes(w));
}
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
  const push = (url: string, title: string, at: number): void => {
    if (out.length >= limit) return;
    if (isRetiredMention(text, at, url.length)) return;
    const clean = cleanBareUrl(url);
    if (!/^https?:\/\//i.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    out.push({
      title: plainTitle(title, labelFromUrl(clean)),
      url: clean,
      via: CONCLUSION_VIA,
    });
  };
  for (const m of text.matchAll(/\[([^\]]{0,120})\]\((https?:\/\/[^)\s]+)\)/g)) {
    push(m[2] ?? "", m[1] ?? "", m.index ?? 0);
  }
  // 裸地址的字符类里同样要排除反引号与星号，否则记号被当成地址的一部分吃进来（cleanBareUrl
  // 只能剥结尾，剥不掉夹在中间的）
  for (const m of text.matchAll(/https?:\/\/[^\s)\]>"'|，。；、`*]+/g)) push(m[0], "", m.index ?? 0);
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

/**
 * 留存正文的规模与截断量。**截断有两层**，此前平台一层都报不出来：
 *
 * 一层是联网扩展自己截断返回内容（details 里自报 `truncated`），实测 202 次联网类调用里 22 次
 * 被工具截断，其中 20 次连正文都没交给我们（`content` 里没有文本块，留存函数原样返回），平台手里
 * 只有查询元数据；另一层是我们留存时的上限（agent-core 的 `MAX_RETAINED_TEXT`，20000 字/次），
 * 实测 1 条被截、10173 字没存下。两层的字段名还撞过一次（都叫 `omittedChars`），已在源头分开。
 *
 * 这两个字段此前在 `apps/web` 里**一个消费者都没有**：界面上看不出来、交付 MD 里也没写。于是
 * 「三处均无出处」「无法核验」这些判定的一个可能成因——引文正好落在被截掉的那一段里——从来没被
 * 说出口，读的人只能以为平台核对过全部原文。
 */
export type RetentionStats = {
  /** 有留存正文的联网类调用数（运行在留存上线之前的调用没有正文字段，不计入） */
  retainedCalls: number;
  /** 其中被平台留存上限截断的条数 */
  truncatedCalls: number;
  /** 留存下来的字数合计 */
  retainedChars: number;
  /** 被平台截掉、没能留存的字数合计 */
  omittedChars: number;
  /** 单条最多截掉多少字（最坏情况，比合计更能说明「有没有可能整段丢掉」） */
  maxOmitted: number;
  /** 联网扩展自报 `truncated: true` 的调用数（工具那一层的截断，与我们的上限无关） */
  toolTruncatedCalls: number;
  /** 其中连正文都没能留存的条数：这些调用平台手里只有查询元数据 */
  toolTruncatedNoBody: number;
  /**
   * 工具层截掉的字数合计。只有撞名时被源头保留下来的那份（`toolOmittedChars`）才计得进来，
   * 历史行里它被我们自己的 `omittedChars` 盖掉了，无从恢复——按「宁可留空也不猜」，不推算。
   */
  toolOmittedChars: number;
};

export function retentionStats(calls: SearchCall[]): RetentionStats {
  const out: RetentionStats = {
    retainedCalls: 0,
    truncatedCalls: 0,
    retainedChars: 0,
    omittedChars: 0,
    maxOmitted: 0,
    toolTruncatedCalls: 0,
    toolTruncatedNoBody: 0,
    toolOmittedChars: 0,
  };
  for (const c of calls) {
    // 与「哪些工具算联网证据」同一份名单：一边决定存不存、一边决定认不认，不另立一套
    if (!SEARCH_TOOL_NAMES.has(c.toolName)) continue;
    const r = asRecord(c.result);
    if (!r) continue;
    const text = typeof r.retainedText === "string" ? r.retainedText : "";
    // 工具层截断要在「有没有留存正文」之前判：实测 22 条里有 20 条根本没有正文字段，
    // 先按正文过滤的话，这一层一条都数不出来（而那恰恰是丢失最严重的一层）。
    if (r.truncated === true) {
      out.toolTruncatedCalls += 1;
      if (text === "") out.toolTruncatedNoBody += 1;
      out.toolOmittedChars += numOf(r.toolOmittedChars);
    }
    if (text === "") continue;
    out.retainedCalls += 1;
    out.retainedChars += numOf(r?.retainedChars);
    const omitted = numOf(r?.omittedChars);
    if (omitted > 0) {
      out.truncatedCalls += 1;
      out.omittedChars += omitted;
      out.maxOmitted = Math.max(out.maxOmitted, omitted);
    }
  }
  return out;
}

/**
 * 有截断才说明，没截断返回 null——不为了显示而显示，也不让「0 条截断」变成一句废话。
 * 措辞刻意不断言「引文一定丢了」：我们不知道被截掉的那段里有什么，只知道核对不到。
 * 两层分开报，因为处置动作不同：工具层截断要换工具或改参数重抓，留存层截断是平台自己的上限。
 */
export function retentionNote(s: RetentionStats): string | null {
  if (s.truncatedCalls <= 0 && s.toolTruncatedCalls <= 0) return null;
  const parts: string[] = [];
  if (s.toolTruncatedCalls > 0) {
    parts.push(
      `联网工具自己截断了 ${s.toolTruncatedCalls} 次返回内容${
        s.toolTruncatedNoBody > 0
          ? `（其中 ${s.toolTruncatedNoBody} 次连正文都没能留存，平台手里只有查询元数据）`
          : ""
      }`,
    );
  }
  if (s.truncatedCalls > 0) {
    parts.push(
      `平台留存时又截断 ${s.truncatedCalls} 条、合计 ${s.omittedChars} 字没有存下（单条最多 ${s.maxOmitted} 字）`,
    );
  }
  const caveat =
    s.toolTruncatedCalls > 0 ? "工具层截掉的字数各工具口径不同，只报条数、不推算字数。" : "";
  return `本任务的联网留存不完整：${parts.join("；")}。${caveat}「无出处 / 无法核验」的判定只针对存下来的那部分：引文若落在被截掉的段落里，平台核对不到，需人工回原页面确认。`;
}
