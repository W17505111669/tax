/**
 * 国家税务总局政策法规库定向检索（官方库，按发文字号精确命中）。
 *
 * 为什么不能只靠通用搜索引擎：实测本机 Bing 对中文长查询已严重退化——`site:` 运算符被完全忽略
 * （「site:chinatax.gov.cn 2019年第41号」返回「2019 - Wikipedia」一类英文兜底页），
 * 「国家税务总局公告2019年第41号 年度汇算清缴起废止」只命中「国家」二字、返回百度百科与维基百科的
 * 「国家」词条；百度持续返回安全验证页。政策文号恰恰最需要确定性来源，而政策法规库的检索接口
 * 返回结构化的 `govDoc.docNum`（完整发文字号），可以按文号精确比对，命中即是官方原文页。
 *
 * 命中门槛是「发文字号归一化后全等」，不是子串包含：库里同时存在后续替代文件
 * （查 2023年第44号 会返回 2026年第23号），子串或宽松匹配会把替代文件当成原文写进证据。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** 集约化统一检索接口：政策法规库前端的取数地址，返回 JSON */
const POLICY_SEARCH_URL = "https://www.chinatax.gov.cn/search5/search/s";
/** 国家税务总局站点编码与政策法规库站点名，取自库内前端 getSearch.js */
const POLICY_SITE_CODE = "bm29000002";
const POLICY_SITE_NAME = "GSFFK";

/** 政策法规库检索命中项 */
export type PolicyLibraryHit = {
  /** 结构化发文字号，如「国家税务总局公告2019年第41号」；库内部分条目为空串 */
  docNum: string;
  title: string;
  url: string;
  pubDate: string;
};

export type PolicyLibraryResult = {
  hits: PolicyLibraryHit[];
  /** 接口自报的命中总数（用于如实说明「返回 N 条里没有发文字号相符的」） */
  total: number;
  status: number | null;
  error: string | null;
};

/** 发文字号归一化：去空白、括号统一成半角方括号，便于跨写法比对 */
export function normalizeDocNum(s: string): string {
  return s.replace(/\s+/g, "").replace(/[〔【]/g, "[").replace(/[〕】]/g, "]");
}

/** 检索接口返回的标题带 <em> 高亮标记，落库前清掉 */
function cleanTitle(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 解析检索响应（纯函数，便于离线验证）。
 * 结果数组挂在 `searchResultAll.searchTotal` 上——名字有迷惑性，`total` 才是命中总数字段。
 */
export function parsePolicyLibrary(payload: unknown): { hits: PolicyLibraryHit[]; total: number } {
  const all = (payload as { searchResultAll?: Record<string, unknown> | null } | null)?.searchResultAll;
  const rows = Array.isArray(all?.searchTotal) ? (all!.searchTotal as unknown[]) : [];
  const hits: PolicyLibraryHit[] = [];
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url.trim() : "";
    // 只认 http(s) 原文页地址：拿不到可用地址的条目当证据没有意义
    if (!/^https?:\/\//i.test(url)) continue;
    const gov = (r.govDoc ?? {}) as Record<string, unknown>;
    hits.push({
      docNum: typeof gov.docNum === "string" ? gov.docNum.trim() : "",
      title: cleanTitle(typeof r.title === "string" ? r.title : ""),
      url,
      pubDate: typeof r.pubDate === "string" ? r.pubDate : "",
    });
  }
  const total = Number(all?.total);
  return { hits, total: Number.isFinite(total) ? total : hits.length };
}

/**
 * 按发文字号精确匹配：归一化后全等才算命中。
 * `want` 必须是「发文机关 + 文号」的完整写法；只给光杆文号（「2022年第28号」）时永远匹配不上，
 * 这是有意的——机关不明就不该猜是哪一份文件。
 */
export function matchPolicyDocNum(want: string, hits: PolicyLibraryHit[]): PolicyLibraryHit | null {
  const target = normalizeDocNum(want);
  if (target === "") return null;
  return hits.find((h) => h.docNum !== "" && normalizeDocNum(h.docNum) === target) ?? null;
}

/** 定向检索政策法规库；网络或接口失败如实回报，不猜、不降级成通用检索结果 */
export async function searchPolicyLibrary(
  query: string,
  signal?: AbortSignal,
): Promise<PolicyLibraryResult> {
  if (query.trim() === "") return { hits: [], total: 0, status: null, error: "检索词为空" };
  const params = new URLSearchParams({
    siteCode: POLICY_SITE_CODE,
    indexCode: "1",
    searchSiteName: POLICY_SITE_NAME,
    searchWord: query,
    pageNum: "0",
    type: "0",
    participleRule: "5",
  });
  try {
    const res = await fetch(`${POLICY_SEARCH_URL}?${params.toString()}`, {
      headers: {
        "User-Agent": UA,
        Referer: "https://fgk.chinatax.gov.cn/zcfgk/c100028/search.html",
        Accept: "*/*",
      },
      signal,
    });
    if (!res.ok) return { hits: [], total: 0, status: res.status, error: `HTTP ${res.status}` };
    const parsed = parsePolicyLibrary(await res.json());
    return { hits: parsed.hits, total: parsed.total, status: res.status, error: null };
  } catch (err) {
    return { hits: [], total: 0, status: null, error: err instanceof Error ? err.message : String(err) };
  }
}
