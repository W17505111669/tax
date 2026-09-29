/**
 * 联网引用的证据力分级：同一条链接，指向政策原文还是门户首页，对交付材料的支撑力完全不同。
 * 实测中出现过把「土地（自然经济综合体）_百度百科」「自然资源部首页」当作土地增值税清算
 * 依据写进结论引用的情况，这里把「能不能作为依据」变成界面上看得见的标注与交付自检项。
 *
 * 纯函数、无 Node 依赖（浏览器直接打包）。口径与 @tax/business-tools 的检索过滤保持一致，
 * 由 apps/api/scripts/verify-citation-grade.ts 用同一批真实地址交叉校验，防止两处漂移。
 */

export type CitationGrade = "official" | "professional" | "weak";

/** 证据力弱的具体原因，用于 tooltip 与交付自检文案 */
export type WeakReason = "entry" | "encyclopedia" | "search" | "unparsable";

export const GRADE_TEXT: Record<CitationGrade, string> = {
  official: "官方原文",
  professional: "专业来源",
  weak: "证据力弱",
};

export const GRADE_HINT: Record<CitationGrade, string> = {
  official: "政府或税务机关站点上的具体文件页，可直接作为政策依据引用",
  professional: "专业机构、媒体或社区的具体文章页，可作参考依据；关键口径请再核对官方原文",
  weak: "不能替代政策原文，交付前请替换为具体文件页",
};

export const WEAK_TEXT: Record<WeakReason, string> = {
  entry: "站点首页或栏目入口，没有具体文件内容",
  encyclopedia: "百科词条，只能作背景了解",
  search: "检索结果页，链接内容会随时间变化",
  unparsable: "地址无法解析",
};

export function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 入口页文件名及其常见变体：index_pc.html、index-m.asp、default.aspx、homepage.htm 一类。
 * 漏掉变体的代价是实测踩到的——www.nda.gov.cn/sjj/index_pc.html 被判成官方原文，
 * 「批量找替代来源」于是把门户首页当成政策原文写进了修订指令。
 */
const ENTRY_LAST_SEGMENT =
  /^(index|main|home|homepage|default|login|logout|register|search)([-_]?(pc|m|mobile|wap|app|cn|en|zh|\d{1,2}))?(\.[a-z]{2,5})?$/i;

/** 入口页：站点首页、单级栏目页、登录/检索页——没有具体文件内容，引用等于没有依据 */
export function isEntryUrl(raw: string): boolean {
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
  if (isFunctionalPath(trimmed)) return true;
  // 单级路径且没有文件扩展名（如 /guoqing）多为门户栏目页
  return !trimmed.slice(1).includes("/") && !/\.[a-z]{2,5}$/i.test(last);
}

/**
 * 功能性页面的路径段：下载页、App 页、工具页、登录注册检索页。
 * 实测踩过：「批量找替代来源」把「国家政务服务平台」换成了同域名下的
 * `app.gjzwfw.gov.cn/fwmhapp/downloadApp/android.html`，域名是官方的、内容却与政策依据无关。
 */
const FUNCTIONAL_SEGMENT =
  /^(download|down|app|apps|apk|tools?|login|logout|register|signup|search|query|help|faq|feedback|sitemap|wap|mobile)[a-z0-9]*$/i;

export function isFunctionalPath(trimmedPath: string): boolean {
  return trimmedPath
    .split("/")
    .filter((s) => s !== "")
    .some((seg) => FUNCTIONAL_SEGMENT.test(seg.replace(/\.[a-z]{2,5}$/i, "")));
}

/** 百科 / 知识库词条：可作背景了解，不能替代政策原文 */
export function isEncyclopediaUrl(raw: string, title = ""): boolean {
  const host = hostOf(raw);
  if (host) {
    if (
      host.startsWith("baike.") ||
      host.startsWith("wiki.") ||
      host.endsWith("wikipedia.org") ||
      host.endsWith("mbalib.com") ||
      host.endsWith("baike.com")
    ) {
      return true;
    }
  }
  // 转载页也常把词条名写进标题，作为兜底信号
  return /_百度百科|百度百科|维基百科|- 维基百科/.test(title);
}

const SEARCH_HOSTS = ["bing.com", "baidu.com", "sogou.com", "so.com", "duckduckgo.com", "google.com", "yandex.com"];

/** 检索结果页：内容是当时那次检索的快照，不能作为固定依据引用 */
export function isSearchResultUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (!SEARCH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return false;
  return /^\/(search|s|wd|web|results)\b/i.test(u.pathname) || u.search.includes("q=") || u.search.includes("wd=");
}

/** 官方来源：政府与税务机关站点（含政策法规库、12366 等子域） */
export function isOfficialUrl(raw: string): boolean {
  const host = hostOf(raw);
  return host === null ? false : host.endsWith("gov.cn") || host.endsWith("gov.hk") || host.endsWith("chinatax.org");
}

export type GradedCitation = { grade: CitationGrade; reason: string; weak?: WeakReason };

/** 单条引用分级：先判「弱」（入口页/百科/检索页），再判官方与专业来源 */
export function gradeCitation(url: string, title = ""): GradedCitation {
  if (hostOf(url) === null) {
    return { grade: "weak", reason: WEAK_TEXT.unparsable, weak: "unparsable" };
  }
  if (isSearchResultUrl(url)) {
    return { grade: "weak", reason: WEAK_TEXT.search, weak: "search" };
  }
  if (isEntryUrl(url)) {
    return { grade: "weak", reason: WEAK_TEXT.entry, weak: "entry" };
  }
  if (isEncyclopediaUrl(url, title)) {
    return { grade: "weak", reason: WEAK_TEXT.encyclopedia, weak: "encyclopedia" };
  }
  if (isOfficialUrl(url)) {
    return { grade: "official", reason: "政府/税务机关站点的具体文件页" };
  }
  return { grade: "professional", reason: "专业机构或社区的具体文章页" };
}

export type GradeSummary = { total: number; official: number; professional: number; weak: number };

/** 分级汇总：界面计数、交付自检与交付包清单共用同一口径 */
export function summarizeGrades(list: Array<{ url: string; title?: string }>): GradeSummary {
  const out: GradeSummary = { total: list.length, official: 0, professional: 0, weak: 0 };
  for (const c of list) out[gradeCitation(c.url, c.title ?? "").grade] += 1;
  return out;
}
