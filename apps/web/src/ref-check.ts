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

import { gradeCitation, isOfficialChannelPage } from "./citation-grade.ts";
import { DOMAIN_KEYWORDS } from "./domain-keywords.ts";
import { linkVerdict, type LinkCheckLike } from "./link-check.ts";
import { CONCLUSION_VIA, extractTextCitations, UNCAPPED } from "./search-evidence.ts";
import { extractDocRefs, normalizeRef } from "./policy-trace.ts";
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
  // 「同时废止国税发〔2008〕116号」一类：动词不剥掉就会拼出「废止国税发[2008]116号」这种
  // 指向不存在文件的检索词，而政策法规库那一路要求发文字号归一化后全等，必然落空
  "废止",
  "修订",
  "修改",
  "作废",
  "依据",
  "根据",
  "按照",
  "依照",
  "参照",
  "确认为",
  "认定为",
  "确认",
  "视为",
  "同时",
  "此外",
  "上述",
  "前述",
  "以下",
  "下列",
  "按",
  "已",
  "并",
  "且",
  "或",
  "则",
  "均",
  "系",
  "另",
  "该",
  "此",
  "其",
  "将",
  "对",
  "把",
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

/** 公文种类词：紧邻部分以这些词结尾时，左边才可能还有联合发文的机关 */
const DOC_KIND_TAIL = /(公告|通知|通告|令|决定|意见|办法|规定|函|文件)$/;
/** 联合发文时机关之间的分隔符（结论里通常是空格，正式标题里也可能是顿号） */
const AGENCY_BEFORE = /([\u4e00-\u9fa5]{2,10})[\s、·]+$/;
/** 机关名结尾字：只有以这些字结尾才继续往左取，避免把「同时废止」一类普通词组当成机关 */
const AGENCY_TAIL = /(部|委|局|署|院|会|行|厅|办|队|处|中心|委员会|办公厅)$/;

/** 公文种类词：机关名后面常紧跟这一个词，它与机关名一起才构成完整发文字号的头部 */
const DOC_KIND_WORD = /(公告|通知|通告|令|决定|意见|办法|规定|函|文件)$/;

/**
 * 常见发文机关与文号代号。匹配时按长度倒序，取能对上结尾的最长一个。
 *
 * 不用「机关结尾字 + 文种词」的正则去截，是因为那种写法贪婪：「扣除按国家税务总局公告」整体
 * 也满足「若干字 + 局 + 公告」，截出来还是带着结论自己的话。实测三处补不上出处的文号全栽在这里
 *（「用加计扣除按国家税务总局公告2018年第23号」「款表述经国家税务总局公告2018年第31号」
 * 「申报说明先后被国家税务总局公告2020年第24号」），黏着前缀拼出的检索词指向不存在的文件，
 * 而政策法规库那一路要求发文字号归一化后全等，必然落空。词表是有限的领域知识，宁可列出来。
 */
const KNOWN_AGENCIES = [
  "国家发展和改革委员会",
  "人力资源社会保障部",
  "市场监督管理总局",
  "国家税务总局办公厅",
  "住房城乡建设部",
  "工业和信息化部",
  "财政部办公厅",
  "国家税务总局",
  "生态环境部",
  "交通运输部",
  "农业农村部",
  "自然资源部",
  "人民银行",
  "税务总局",
  "海关总署",
  "商务部",
  "民政部",
  "财政部",
  "科技部",
  "国务院",
  "财关税",
  "税总函",
  "税总发",
  "国税发",
  "国税函",
  "财综",
  "财税",
].sort((a, b) => b.length - a.length);

/** 从紧邻文号的那段中文里截出真正的发文机关；截不出就原样返回，交给 plausibleAgency 判定 */
export function agencyTail(head: string): string {
  const kind = head.match(DOC_KIND_WORD);
  const body = kind === null ? head : head.slice(0, head.length - kind[0].length);
  const agency = KNOWN_AGENCIES.find((a) => body.endsWith(a));
  if (agency === undefined) return head;
  return kind === null ? agency : `${agency}${kind[0]}`;
}
/** 光杆公告号：只有年份与序号、不带发文机关代号，单靠它去检索等于捞噪声 */
const BARE_GONGGAO = /^\d{4}\s*年第\s*\d+\s*号$/;

/**
 * 文号前面的发文机关（「根据财税〔2015〕119号」→「财税」，「国家税务总局公告2017年第40号」→ 原样保留）。
 * 只靠「〔2015〕119号」检索命中率很低，补上发文机关才是一条能用的检索词。
 *
 * 联合发文必须连着一起取：「财政部 税务总局 科技部公告2022年第28号」若只取紧邻的
 * 「科技部公告」，检索词指向的就是一份不存在的文件，实测这类文号一直复查不到出处。
 * 机关名之间以空格或顿号分隔，因此仅在紧邻部分以公文种类词结尾、且左边那段以机关结尾字
 * 收尾时才往左延伸——两个条件缺一不可，否则会把 markdown 表格里空格分隔的普通中文吞进来。
 */
export function refPrefix(context: string, refText: string, maxChars = 12): string {
  const idx = context.indexOf(refText);
  if (idx <= 0) return "";
  const before = context.slice(0, idx);
  const m = before.match(/[\u4e00-\u9fa5]{2,}$/);
  const base = m ? agencyTail(trimEdgeWords(m[0].slice(-maxChars))) : "";
  if (base === "" || !DOC_KIND_TAIL.test(base)) return base;
  let tail = m ? before.slice(0, before.length - m[0].length) : before;
  const agencies: string[] = [];
  // 联合发文极少超过五个机关，够覆盖「财政部 税务总局 科技部」与四部委集成电路公告两类写法
  for (let guard = 0; guard < 5; guard += 1) {
    const g = tail.match(AGENCY_BEFORE);
    if (!g || !AGENCY_TAIL.test(g[1]!)) break;
    agencies.unshift(g[1]!);
    tail = tail.slice(0, tail.length - g[0].length);
  }
  return agencies.length === 0 ? base : `${agencies.join(" ")} ${base}`;
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
  // 前缀为空有两种情况，只有第一种需要主题词兜底：
  // 「财税〔2015〕119号」这类文号自带机关代号，照旧用上下文关键词；
  // 「2022年第28号」这种光杆公告号（除年份序号外不带任何机关信息），上下文又只剩
  // 「项同时废止」一类残句时，检索必然全是噪声，改用任务主题词做领域限定。
  const tail = prefix === "" && BARE_GONGGAO.test(t.text.trim()) ? (t.hint ?? "").trim() || kw : kw;
  return [`${prefix}${t.text.trim()}`, tail].filter((s) => s !== "").join(" ");
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

/**
 * 需要找替代来源的弱证据引用（门户首页 / 百科词条 / 检索页），按引用清单顺序取前 limit 条。
 *
 * exclude 里的地址在切片**之前**就剔掉：已处置的项（结论里声明过为背景参考的、只在检索留存里的）
 * 不该占配额。实测 4bb22d34 有 14 条弱证据、配额 10 条，先切片再过滤的话前 10 条正好全被已处置的
 * 占满，真正该删的两条百科词条永远进不了清单，批量入口对它就是 ran=0。
 */
export function citationTargets(
  citations: Array<{ title: string; url: string; grade: string }>,
  hint: string,
  limit = 10,
  exclude: ReadonlySet<string> = new Set<string>(),
): RefCheckTarget[] {
  return citations
    .filter((c) => c.grade === "weak" && !exclude.has(c.url))
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

/** 词元能对上涉税领域词表：互为子串即算（「研发」是「研发费用」的一部分，「土地」是「土地增值税」的一部分） */
export function isDomainToken(token: string): boolean {
  const t = token.toLowerCase();
  if (t === "") return false;
  return DOMAIN_KEYWORDS.some((k) => {
    const w = k.toLowerCase();
    return w.includes(t) || t.includes(w);
  });
}

/**
 * 共同主题词里够格支撑「两者谈的是同一件事」的那些。
 *
 * 判「找到官方原文」只要求「有共同词」是不够的：实测一条弱证据「国情_中国政府网」被换成了
 * gov.cn 上的《全面认识和把握我国基本国情》——两者只共用「国情」这一个泛词，谈的根本不是
 * 同一件事，却因此被判成 matched 并写进了修订指令。通用词黑名单是手工维护的，永远会漏
 * （「国家」「政府」都在表里，「国情」却漏了），因此对 matched 改用白名单口径：
 * 共同词里至少要有一个能对上领域词表，对不上就降为 candidate 交人工确认。
 * 这与本文件既定的「宁可漏判，不可误判成找到官方原文」一致。
 *
 * 领域词之外还认「两边出现同一个政策文号」：原引用标题本身就是文号时（弱证据清单里常见），
 * 命中页出现同一文号是最强的同一性证据，比领域词更强，不能因为它不是领域词就降级。
 */
export function domainOverlap(originalTitle: string, hitTitle: string, hitSnippet = ""): string[] {
  const domains = topicOverlap(originalTitle, hitTitle, hitSnippet).filter(isDomainToken);
  if (domains.length > 0) return domains;
  const want = new Set(extractDocRefs(originalTitle).map((r) => r.core));
  if (want.size === 0) return [];
  const got = new Set(extractDocRefs(`${hitTitle} ${hitSnippet}`).map((r) => r.core));
  return [...want].filter((c) => got.has(c));
}

/**
 * 命中页是否与「这份结论」谈的是同一件事：与任务主题词共享一个完整的涉税领域词。
 *
 * 只看与原引用标题的共同词还不够。原引用常常是百科词条或门户首页（「土地（汉语词语）_百度百科」
 * 「土地交易 - 上海土地市场」），标题里的词本身没有主题价值；而 `isDomainToken` 按互为子串判定，
 * 「土地」是「土地增值税」的前缀就会通过。实测因此把《中华人民共和国土地管理法实施条例》当成了
 * 替代来源——只因为都含「土地」，而这份结论谈的是土地增值税清算，正是通用词表注释里早就
 * 警告过的那类混淆（「都含『土地』就把《土地管理法》当成土地增值税清算依据」）。
 *
 * 任务主题词取自结论里出现最多的领域词（`topicHint`），因此这里要求的是完整词条共现：
 * 主题词含「土地增值税」而命中页不含，就不算谈同一件事。主题词为空时返回 false，由调用方决定回退。
 */
export function onTaskTopic(taskHint: string, hitTitle: string, hitSnippet = ""): boolean {
  if ((taskHint ?? "").trim() === "") return false;
  const hit = `${hitTitle} ${hitSnippet ?? ""}`;
  return DOMAIN_KEYWORDS.some((k) => taskHint.includes(k) && hit.includes(k));
}

/**
 * 与这份结论无关的弱证据引用标题。
 *
 * 实测结论里出现过「国家（政治地理学名词）_百度百科」「中华人民共和国_百度百科」
 * 「国家政务服务平台」这类词条：它们不是政策依据，也永远找不到「同主题的官方原文」来替换
 * ——复查层对它们只能判候选，于是待办清单里挂着一堆谁也解决不了的项。这类引用的正确处置
 * 是从结论里删掉，而不是花时间找替代来源，因此单列出来交给交付自检提醒。
 *
 * 判据刻意保守，因为这里的误判代价与复查层相反：复查层误判只是多一条候选（交人工确认），
 * 这里误判会劝人删掉正当引用。两道限制缺一不可——
 * 1. 只看证据力弱的引用（门户首页 / 百科词条 / 检索页）。官方与专业来源即使标题用词与结论
 *    不同也不该被建议删除；实测按「与任务主题词有交集」判会把 54 条引用里的 50 条判为跑题，
 *    因为标题常常很短（「研发_百度百科」）或干脆是一串裸网址，凑不出完整领域词。
 * 2. 比的是整篇结论正文而不是两三个主题词，且要求标题去虚词后与正文没有任何共同实词。
 * 标题取不出任何实词时不判（无从判断，不猜）；结论正文为空时同样不判。
 */
export function offTopicCitationTitles(
  citations: Array<{ title: string; url: string }>,
  conclusionText: string,
): string[] {
  // 先把引用清单本身从正文里剔掉再取词元：结论通常会在末尾列出引用标题，
  // 不剔就变成拿标题和它自己比，任何引用都「与正文有共同实词」，一条也判不出来
  //（实测按整篇正文比对时 54 条引用里 0 条被判跑题）。
  let body = conclusionText ?? "";
  for (const c of citations) {
    // 标题与地址都要剔掉。剔标题是因为结论末尾常列引用清单，留着就是拿标题和它自己比
    //（自证循环，实测会让 54 条引用一条也判不出来）；剔地址是因为地址里的数字与域名片段
    // 同样会混进词元——实测「12366纳税服务平台」正因为它自己的地址写在结论里，
    // 标题词元「12366」与正文撞车而蒙混过关。实测 54 条引用里只有 32 条标题原样出现在
    // 结论中，却有更多条的地址在正文里，只剔标题会漏掉一大片。
    if (c.title.trim() !== "") body = body.split(c.title).join(" ");
    if (c.url.trim() !== "") body = body.split(c.url).join(" ");
  }
  const base = new Set(topicTokens(body));
  if (base.size === 0) return [];
  return citations
    .filter((c) => gradeCitation(c.url, c.title).grade === "weak")
    .filter((c) => {
      const tokens = topicTokens(c.title);
      return tokens.length > 0 && tokens.every((t) => !base.has(t));
    })
    .map((c) => c.title);
}
/** 候选排序：官方原文优先，其次专业来源，再看相关度 */
const GRADE_RANK: Record<string, number> = { official: 0, professional: 1, weak: 2 };

/**
 * 候选说明：把「两道主题关各自过没过」如实讲清楚。
 *
 * 早先不论哪道关拦下的都写「与原引用没有共同的涉税领域词」，实测 17 条候选全挂着这一句，
 * 而其中真正的原因往往是第二道关——替代来源与原引用共用了「土地」一类领域词，却与这份结论的
 * 主题词（「土地增值税」）不相干，正是 gradeRefCheck 注释里点名要挡的那类替换。人工复核照着
 * 错的说明去补，只会往错的方向找。
 *
 * 结论里取不到领域词时也要说清：那是「无从判断」，不是「判断为不相干」，两者的处置方式不同。
 */
export function topicGapReason(originalTitle: string, hint: string, hitTitle: string, hitSnippet = ""): string {
  const overlap = domainOverlap(originalTitle, hitTitle, hitSnippet);
  const h = (hint ?? "").trim();
  // 第二道关的三种结果要分开说：不相干是判定，取不到领域词是无从判定，处置方式不同
  const topic =
    h === ""
      ? { text: "结论里取不到涉税领域词，无从判断它谈的是不是这份结论的事", ok: false }
      : onTaskTopic(h, hitTitle, hitSnippet)
        ? { text: `与结论主题词「${h}」相符`, ok: true }
        : { text: `与结论主题词「${h}」不相干，看不出谈的是这份结论的事`, ok: false };
  // 返回值自带句首连接词，调用方直接接在「检索到官方站点页面」后面。
  // 连接词按两段的肯定/否定配对：两段都否定用「且」，一肯定一否定用「但」。
  // 实测把连接词留在调用方会撞车——外层固定写「但」，内层又起「虽」，出来是「但虽与原引用…」。
  if (overlap.length > 0) {
    return `虽与原引用「${originalTitle}」有共同涉税领域词「${overlap.join("、")}」，但${topic.text}`;
  }
  return topic.ok
    ? `与原引用「${originalTitle}」没有共同的涉税领域词，但${topic.text}`
    : `但与原引用「${originalTitle}」没有共同的涉税领域词，且${topic.text}`;
}

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
    // 官方域名只是必要条件，还要过两关：
    // 一是与原引用谈的是同一件事，否则会把同域名下的 App 下载页、工具页当成政策原文写进修订指令；
    // 二是不能是税务机关主站的解读/新闻频道页——它由官方发布、分级也是 official，但它是「讲这份文件的」
    //    而不是文件本身，拿来替换弱证据引用与「找到官方原文」的承诺不符。
    // 不限定为政策法规库：科技部一类的官方文件页（most.gov.cn 上的指引 PDF）同样是合格的原文。
    const isOfficial = (h: RefSearchHit) =>
      gradeCitation(h.url, h.title).grade === "official" && !isOfficialChannelPage(h.url);
    // 两道主题关：既要与原引用谈同一件事，也要与这份结论谈同一件事。
    // 后者才挡得住「土地（汉语词语）_百度百科 → 土地管理法实施条例」这类替换。
    // 结论里取不到任何领域词时（onTaskTopic 返回 false）一律不判 matched：连这份结论谈什么都
    // 确定不了，就没法断言替代来源与它同主题，按本文件既定的「宁可漏判降为 candidate」处理。
    const hint = (t.hint ?? "").trim();
    const official = pool.find(
      (h) =>
        isOfficial(h) &&
        domainOverlap(t.text, h.title, h.snippet ?? "").length > 0 &&
        onTaskTopic(hint, h.title, h.snippet ?? ""),
    );
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
        note: `检索到官方站点页面，${topicGapReason(t.text, hint, unrelated.title, unrelated.snippet ?? "")}，需人工确认后再替换`,
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

/**
 * 需要复查的文号：待人工确认 + 无法从留存数据核验（两类都还没有可核对的出处）。
 *
 * hint 传任务主题词：结论写成「同时废止 2021年第13号、2022年第16号、2022年第28号」这类清单时，
 * 上下文里连发文机关都没有，光靠文号数字去检索必然全是噪声，得用主题词做领域限定。
 */
/**
 * 从该文号所有出现位置里挑一个能构造出可信发文机关的上下文。
 *
 * 首次出现常是光杆写法（「附件表单先后被 2020年第24号、2021年第34号 部分废止」），后面某次才带
 * 机关（「申报说明先后被国家税务总局公告2020年第24号」）；只认首次就等于把机关白丢掉。
 * 全都构造不出机关时沿用首次上下文，由调用方按「机关不明就不猜」跳过政策法规库那一路。
 */
export function bestRefContext(ref: { text: string; context: string; contexts?: string[] }): string {
  for (const c of ref.contexts ?? []) {
    const p = refPrefix(c, ref.text);
    if (p !== "" && plausibleAgency(p)) return c;
  }
  return ref.context;
}

export function refCheckTargets(trace: RefTraceResult, hint = ""): RefCheckTarget[] {
  return [...trace.untraced, ...trace.unverifiableRefs].map((r) => ({
    key: refKey("docref", r.text),
    kind: "docref" as const,
    text: r.text,
    context: bestRefContext(r),
    hint,
  }));
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
    /** 原引用标题或文号原文：引用替换的主题相关判据要用它重算，缺了就纠正不了收紧前的误判 */
    text?: string;
    verdict: RefCheckVerdict;
    evidence?: { url: string; title: string; snippet?: string } | null;
  }>,
  stillValid: (check: {
    kind?: RefCheckKind;
    text: string;
    evidence: { url: string; title: string; snippet?: string } | null;
  }) => boolean = () => true,
): T[] {
  const done = new Set(
    checks
      .filter(
        (c) =>
          c.verdict === "matched" &&
          stillValid({ kind: c.kind, text: c.text ?? "", evidence: c.evidence ?? null }),
      )
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
 * 旧的「已找到公开出处」现在还站得住吗：按复查类型用当前判据重算一遍。
 * - 文号复查承诺的是「公开页面里出现了这个文号」，专业来源（税务实务库、法规 PDF）同样算出处，
 *   只有掉到「证据力弱」（门户首页、百科词条）才算失效；
 * - 引用替换承诺的是「找到官方原文」，因此必须仍是官方站点、不是税务机关的解读/新闻频道页，
 *   且与原引用谈的是同一件事（`domainOverlap` 非空）。
 *
 * 主题相关这一条是后加的判据，必须在这里同样生效，否则收紧只对新增记录有效：
 * 实测库里有 9 条引用替换是在旧判据下判成 matched 的，拿《全面认识和把握我国基本国情》替换
 * 「国情_中国政府网」、拿《中华人民共和国宪法》替换「中华人民共和国_百度百科」、拿
 * 「国家政务服务平台 个人办事」替换同名门户——都是只共用了泛词。这些记录一旦被不降级护栏
 * 锁死就再也纠正不回来，而它们会顺着修订指令与交付材料扩散成「已找到官方原文」。
 *
 * `originalText` 缺省时跳过主题相关判定，保持既有调用方与离线测试的行为不变。
 */
export function matchedStillValid(
  kind: RefCheckKind,
  evidence: { url: string; title: string; snippet?: string } | null,
  gradeOf: (url: string, title: string) => { grade: string },
  originalText = "",
  taskHint = "",
): boolean {
  if (!evidence || evidence.url === "") return false;
  const grade = gradeOf(evidence.url, evidence.title).grade;
  if (kind !== "citation") return grade !== "weak";
  if (grade !== "official" || isOfficialChannelPage(evidence.url)) return false;
  if (originalText !== "" && domainOverlap(originalText, evidence.title, evidence.snippet ?? "").length === 0) {
    return false;
  }
  // 与新增判定同一口径，且同样不设「主题词为空就放过」的回退：
  // 实测任务 060b4eea 的结论里没有任何领域词，回退会把《土地管理法实施条例》
  // 当成「土地（汉语词语）_百度百科」的有效替代来源永久锁在 matched 上。
  return onTaskTopic(taskHint, evidence.title, evidence.snippet ?? "");
}

/** 保留旧证据时写进 note 的说明：把这次重试如实记下来，不藏失败 */
export function preservedNote(prevNote: string, next: RefCheckVerdict, checkedAt: string): string {
  const stamp = `${checkedAt.slice(0, 19).replace("T", " ")} 再次检索为「${REF_VERDICT_TEXT[next]}」，保留此前已找到的公开出处`;
  return prevNote.trim() === "" ? stamp : `${prevNote.trim()}；${stamp}`;
}

/**
 * 新证据能不能顶掉旧证据（两者都已是 matched 时才有意义）。
 *
 * 旧证据已是官方原文时，只有同为官方原文才能替换。文号复查加了升级通道之后，重跑已 matched
 * 的记录变多了，没有这道闸就会出现反向替换：一次通用检索拿商业站点顶掉已有的政策法规库原文页。
 * 旧证据是专业来源时不设限——把它升级成官方原文正是这条通道要做的事。
 * 引用类复查另有「必须仍是官方站点」的门槛（见 matchedStillValid），这里不重复管。
 */
export function evidenceCanReplace(
  kind: RefCheckKind,
  prevGrade: string | null,
  nextGrade: string | null,
): boolean {
  if (kind !== "docref") return true;
  if (prevGrade === null || prevGrade === "") return true;
  if (prevGrade !== "official") return true;
  return nextGrade === "official";
}

/** 因证据力不及旧记录而保留旧证据时写进 note 的说明：升级尝试失败也要如实留痕 */
export function keptBetterNote(prevNote: string, nextGrade: string, checkedAt: string): string {
  const stamp = `${checkedAt.slice(0, 19).replace("T", " ")} 再次检索到的来源证据力为「${nextGrade}」，不及已留存的官方原文，保留原证据`;
  return prevNote.trim() === "" ? stamp : `${prevNote.trim()}；${stamp}`;
}

/**
 * 发文机关是否可信：去掉前导虚词后，要么以公文种类词结尾（公告/通知/函…），
 * 要么本身就是「财税」「国税发」「国税函」「税总函」一类的短代号。
 * 用来挡住「研发费用加计扣除财税」这种把关键词和机关黏在一起的串当机关用。
 */
export function plausibleAgency(head: string): boolean {
  const h = trimEdgeWords(head);
  if (h === "" || h.length > 20) return false;
  return DOC_KIND_TAIL.test(h) || h.length <= 4;
}

/**
 * 从一条已 matched 的文号复查记录里取出可跨任务复用的完整发文字号，取不到就返回空串。
 *
 * 依次试 `snippet` 与 `query`：政策法规库精确命中时 snippet 存的就是发文字号；通用检索命中时
 * snippet 往往是页面正文的一段话，但当时的检索词（紧凑写法）恰好就是「发文机关 + 文号」，
 * 实测「国家税务总局公告2015年第97号」「财政部 税务总局 科技部公告2022年第28号」都完整留在 query 里。
 *
 * 两条来源都要求：以该文号结尾、且文号前面的部分是可信的发文机关。带上下文关键词的检索词
 * （「…119号 企业研发费用加计扣除比例」）不以文号结尾，自然被排除，不会把关键词当成机关。
 * 光杆字号（没补出机关）一律返回空串——跨机关有歧义，不能当复用键。
 */
export function reusableDocNum(text: string, snippet: string, query = ""): string {
  const core = normalizeRef(text);
  if (core === "") return "";
  for (const raw of [snippet, query]) {
    const full = normalizeRef(raw);
    if (full === "" || full === core || !full.endsWith(core)) continue;
    if (plausibleAgency(full.slice(0, full.length - core.length))) return full;
  }
  return "";
}

/**
 * 光杆文号的唯一同字号认定：结论里没写发文机关时，从平台已核实的完整字号里找唯一后缀匹配。
 *
 * `reusableDocNum` 刻意不收光杆字号，因此「机关不明」的文号此前整条政策法规库路径都被跳过，
 * 只能退回通用检索——实测捞回来的是国家统计局一类同域名却与涉税主题无关的页面，还按 official
 * 分级展示，比没有证据更容易误导。这里不是猜机关：候选全部来自本平台已按完整字号精确命中
 * 政策法规库原文页并落库的记录，且要求后缀匹配唯一。多于一条即跨机关有歧义，返回 null 维持原样。
 */
export function uniqueVerifiedDocNum(bare: string, verifiedKeys: Iterable<string>): string | null {
  // 库里同时存在「〔2006〕187 号」与「〔2006〕187号」两种写法，比对前先去掉空白。
  // 返回的始终是索引里的原键，不会把光杆写法当成完整字号传出去。
  const core = normalizeRef(bare).replace(/\s+/g, "");
  if (core === "") return null;
  let found: string | null = null;
  for (const key of verifiedKeys) {
    if (!key.replace(/\s+/g, "").endsWith(core)) continue;
    // 第二条匹配就说明跨机关有歧义，宁可维持未解决也不猜
    if (found !== null) return null;
    found = key;
  }
  return found;
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

/** 结论里「这条不作为依据」的交代用语 */
const DISCLAIMER_MARKERS = ["仅作背景参考", "不作为政策依据", "未取得公开原文"];

/** 整节声明：标题写明这一节都是没取得原文的项目时，节内条目一律算已交代 */
const DISCLAIMER_HEADING = /未取得公开原文|仅作背景参考/;
const HEADING_LINE = /^#{1,6}\s/;

/**
 * 这条素材是不是已经在结论里交代过「不作为依据」。
 *
 * 修订指令要求给查不到原文的引用写上「未取得公开原文，仅作背景参考，不作为政策依据」，模型照做
 * 之后交代就留在结论里。实测有两种形态：写在与地址同一行的表格单元里（4bb22d34 单列了一节表格，
 * 逐条写明地址与这句话），或写在整节声明之下。因此判据是「同一行有交代用语」或「位于已声明的
 * 章节内」，窗口只到行首行尾——跨行会把下一行的交代算到上一行头上，密集表格里错得很快。
 */
export function isDisclaimedInConclusion(conclusion: string, identity: string): boolean {
  const key = (identity ?? "").trim();
  if (!conclusion || key === "") return false;
  let inSection = false;
  for (const line of conclusion.split(/\r?\n/)) {
    if (HEADING_LINE.test(line)) inSection = DISCLAIMER_HEADING.test(line);
    if (!line.includes(key)) continue;
    if (inSection || DISCLAIMER_MARKERS.some((m) => line.includes(m))) return true;
  }
  return false;
}

/**
 * 结论已声明为背景参考的弱证据引用地址。
 * 优先按地址认；地址没被正文原样列出时退回按标题认（工具留存的引用常常只在清单里出现一次）。
 */
export function disclaimedWeakUrls(
  citations: Array<{ url: string; title?: string }>,
  conclusion: string,
): Set<string> {
  const out = new Set<string>();
  for (const c of citations) {
    if (gradeCitation(c.url, c.title ?? "").grade !== "weak") continue;
    if (isDisclaimedInConclusion(conclusion, c.url) || isDisclaimedInConclusion(conclusion, c.title ?? "")) {
      out.add(c.url);
    }
  }
  return out;
}

/**
 * 只在检索留存里、从未进结论正文的弱证据引用地址。
 *
 * 引用清单是「工具留存 + 结论正文」两份合并的，这是刻意口径：检索看到过什么也是留痕。但欠账不是留痕——
 * 一条从没被写进结论的百科词条，既不是交付材料的依据，也没法在结论里给它补标注，催人替换等于催一件
 * 无处可做的事。实测 9 条待处置弱证据里 6 条属于这种（7459b28a 的「研发_百度百科」两条、4bb22d34 的
 * 电子税务局与 12366 门户四条）。
 *
 * 「进没进结论」按 extractTextCitations 的结果判，不用 includes 直接搜原文：提取走过同一份清理与截断规则，
 * 也天然排除「原引用 X 已失效」这类作废交代——只被作废交代提到的地址同样不算在用。
 */
export function uncitedWeakUrls(
  citations: Array<{ url: string; title?: string }>,
  conclusion: string,
): Set<string> {
  const cited = new Set(extractTextCitations(conclusion ?? "", UNCAPPED).map((c) => c.url));
  const out = new Set<string>();
  for (const c of citations) {
    if (gradeCitation(c.url, c.title ?? "").grade !== "weak") continue;
    if (cited.has(c.url)) continue;
    out.add(c.url);
  }
  return out;
}

/**
 * 已经处置掉、不必再催的弱证据引用地址：结论里交代过为背景参考的 + 从未进结论正文的。
 * 待处置数 = 弱证据总数 - 这个集合的大小，欠账、待办、批量复查预算一律按待处置数说话。
 */
export function settledWeakUrls(
  citations: Array<{ url: string; title?: string }>,
  conclusion: string,
): Set<string> {
  const out = disclaimedWeakUrls(citations, conclusion);
  for (const u of uncitedWeakUrls(citations, conclusion)) out.add(u);
  return out;
}

/**
 * 还没写回结论的修订素材。写回脚本与结果页「生成修订指令」共用这一份判据。
 *
 * 三类都要挡，否则指令会反复催办同一件事：
 * 1. 查不到原文、但结论里已经交代过「仅作背景参考，不作为政策依据」的——交代过就不必再交代。
 *    此前这一段没有任何判据（写回脚本的注释写着「没有地址可比，仍会列出，由人工决定」），
 *    于是每轮续跑都把同样几条重写一遍：实测 4bb22d34 白跑 300 秒，那节表格被原样重抄，
 *    指令重复还挤占模型注意力，同一轮里该撤的失效地址就没撤干净。
 * 2. 引用类素材的原地址根本不在结论正文里的——只在检索留存里出现过，没处可标注。
 * 3. 已找到出处、且证据地址与原地址都处置完的——替代地址写进结论、原地址也从引用清单里消失。
 *    只认「替代地址在不在正文」会把做了一半的替换当成已完成：实测 4bb22d34 的两条百科词条
 *    复查判定 matched、替代地址也进了结论，但原百科链接原样留着，弱证据仍挂在交付材料里，
 *    而写回脚本因为「已写回」再也不提这两条。
 */
export function pendingRevisionItems(items: RevisionItem[], conclusion: string): RevisionItem[] {
  // 结论里真在用的地址：走同一份提取管线，作废交代里的地址自然不算在用
  const cited = new Set(extractTextCitations(conclusion ?? "", UNCAPPED).map((c) => c.url));
  return items.filter((i) => {
    if (i.verdict !== "candidate" && i.verdict !== "empty") {
      if (!i.evidence || !cited.has(i.evidence.url)) return true;
      // 替代地址已进结论：原地址还在就是只替换了一半，得继续催；不在了才算写回
      return i.kind === "citation" && i.subjectUrl !== undefined && i.subjectUrl !== "" && cited.has(i.subjectUrl);
    }
    if (i.kind === "citation" && i.subjectUrl !== undefined && i.subjectUrl !== "" && !cited.has(i.subjectUrl)) {
      return false;
    }
    const identity = (i.kind === "citation" ? i.subjectUrl || i.text : i.text).trim();
    return !isDisclaimedInConclusion(conclusion, identity);
  });
}

/** 复查后仍没取得出处的素材该怎么处置 */
export type UnresolvedAdvice = "drop" | "narrow" | "mark";

/**
 * 按「这条引用到底是什么」分派处置方式。
 *
 * 此前不论哪一类都塞进同一段【标注未取得原文】，让模型统一写「仅作背景参考，不作为政策依据」。
 * 对百科词条这是错的处置：交付自检对同一批引用说的是「这类词条找不到同主题的官方原文，建议直接从
 * 结论中删掉」，两处建议互相打架；而模型照指令写下的那句交代还会把词条合法化——它从此变成「已声明
 * 的背景参考」，不再被催办，一条本该删掉的泛词条就这么留在了交付材料里。门户首页与检索结果页也不该
 * 只标注：站点是官方的，缺的是具体文件页，让模型改引比让它写免责声明有用得多。
 */
export function unresolvedAdvice(i: RevisionItem): UnresolvedAdvice {
  if (i.kind !== "citation" || !i.subjectUrl) return "mark";
  const weak = gradeCitation(i.subjectUrl, i.text).weak;
  if (weak === "encyclopedia") return "drop";
  if (weak === "entry" || weak === "search") return "narrow";
  return "mark";
}

/**
 * 把复查结果写成一条「续跑」修订指令：人工核对后提交给 Agent 重写依据与引用。
 * 平台不自动改写结论——指令只是填进续跑输入框，改不改、怎么改由税务师决定。
 * 没有可用素材时返回空串，调用方据此禁用按钮。
 */
export function buildRevisionInstruction(
  items: RevisionItem[],
  deadLinks: Array<{ title: string; url: string }> = [],
): string {
  if (items.length === 0 && deadLinks.length === 0) return "";
  const docMatched = items.filter((i) => i.kind === "docref" && i.verdict === "matched");
  const citMatched = items.filter((i) => i.kind === "citation" && i.verdict === "matched");
  const unresolved = items.filter((i) => i.verdict === "candidate" || i.verdict === "empty");
  const toDrop = unresolved.filter((i) => unresolvedAdvice(i) === "drop");
  const toNarrow = unresolved.filter((i) => unresolvedAdvice(i) === "narrow");
  const toMark = unresolved.filter((i) => unresolvedAdvice(i) === "mark");
  const itemLine = (i: RevisionItem): string =>
    `- ${i.text}${i.subjectUrl ? ` ${i.subjectUrl}` : ""}（复查判定：${REF_VERDICT_TEXT[i.verdict]}${
      i.evidence ? `，候选页《${i.evidence.title}》 ${i.evidence.url}，需人工确认` : ""
    }）`;
  const lines: string[] = [
    "请依据下列联网核对结果修订上一轮结论中的政策依据与联网引用；只改依据与引用部分，不要改动金额、测算过程、差异认定与结论意见。",
    "本轮只修订文字：不要重新调用解析、底稿生成、模板填列或底稿比对一类业务工具，也不要重新生成产物——已有工具结果与比对记录是上一轮的交付证据，重跑会把它们替换掉。",
    // 这条是实测换来的：只说「改哪部分」不说「交回什么形式」，模型会交一份改动报告而不是修订后的结论，
    // 而它交回的文本会整体成为新的结论正文——交付材料就此变成一份日志。
    "输出形式：直接给出修订后的完整结论正文，上一轮的章节、表格、金额与结论意见原样保留，只在政策依据与联网引用处做下面的增补或替换。不要输出「本轮处理范围」「核验过程」「改动清单」一类内容——你交回的文本会整体成为新的结论正文，写成改动日志等于把交付材料换成一份日志（实测踩过：一次写回后结论开头从「一、测算结论」变成「一、本轮处理范围与前置说明」，政策文号从 5 处掉到 2 处、金额溯源项少了 22 个）。",
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
      // 「替换」两个字不够硬：实测同一批百科词条连续三轮都只补不删——官方原文加进来了，
      // 原来的百科链接还原样挂在引用清单里，弱证据一条没少，而写回脚本一度还把它当「已写回」。
      "【替换弱证据引用】以下引用原先指向门户首页、百科词条或检索结果页，现已找到官方原文。请把原来那条引用**整条删掉**（正文与联网引用清单里都不留），改用下面的官方原文，并给出标题、URL 与检索时间。不要新旧两条并列保留：并列等于交付材料里仍挂着一条证据力弱的引用，平台会继续把它算作待处置欠账，下一轮修订指令还会再列一次：",
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
  if (toDrop.length > 0) {
    lines.push(
      "【删掉泛词条引用】以下引用是百科词条、问答社区一类泛词条，既不是政策依据，也永远找不到同主题的官方原文。请从结论正文与联网引用清单中删掉这些条目；确实需要交代背景的，用一句文字说明即可，不要留着地址当依据：",
    );
    for (const i of toDrop) lines.push(itemLine(i));
    lines.push("");
  }
  if (toNarrow.length > 0) {
    lines.push(
      "【改引具体文件页】以下引用指向门户首页、栏目页或检索结果页，不是可引用的具体文件页。请改引同一站点下的具体文件页（给出标题、URL 与检索时间）；确实找不到具体文件页的，把这条引用删掉，不要留着首页当依据：",
    );
    for (const i of toNarrow) lines.push(itemLine(i));
    lines.push("");
  }
  if (toMark.length > 0) {
    lines.push(
      "【标注未取得原文】以下项目联网复查后仍未取得政策原文，请在结论中明确写「未取得公开原文，仅作背景参考，不作为政策依据」，不得据此认定企业处理错误：",
    );
    for (const i of toMark) lines.push(itemLine(i));
    lines.push("");
  }
  if (deadLinks.length > 0) {
    lines.push(
      "【替换失效链接】以下引用链接经服务端 GET 核验返回 4xx（不是反爬拒绝），大概率已失效。请检索当前有效地址替换并更新检索时间；确实找不到有效地址的，把这条引用从结论中删掉，或改成文字说明并注明原地址已失效。不要原样留着失效地址当依据：",
    );
    for (const d of deadLinks) lines.push(`- 「${d.title}」 ${d.url}`);
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

/** 一条已核验的引用链接（link_checks 的行形状） */
export type CheckedLink = LinkCheckLike & { url: string };

/**
 * 该写进修订指令的失效链接。
 *
 * 链接腐烂此前只能被发现、不能被修复：交付自检会提醒「失效链接交付前请替换或补充依据」，
 * 但没有任何一条路径把它送进修订指令，唯一出路是人工去改结论正文。
 *
 * 两道过滤缺一不可：
 * 1. 只取判为 dead 的（4xx 且非反爬拒绝）。反爬拒绝与网络不可达都不算失效——按既定口径反爬
 *    不计入交付风险，写进指令会逼人替换一条其实有效的官方链接（实测省级税务机关站点的 WAF
 *    会回 412）。
 * 2. 只取仍在当前引用清单里的地址。link_checks 按 (task_id, url) upsert 且从不删行，结论改过
 *    或被回滚之后旧地址的行还挂在库里，不过滤就会把早已不在交付材料里的地址写进指令
 *   （实测有一行来自被回滚掉的那一轮）。
 */
export function deadLinkTargets(
  checks: CheckedLink[],
  citations: Array<{ url: string; title?: string; via?: string }>,
): Array<{ title: string; url: string }> {
  // 只认结论正文里的地址。修订能改的只有结论正文，工具留存是历史调用结果、改不动；
  // 实测有一条失效地址来自被回滚掉那一轮的工具留存，结论里早已没有它，列进指令模型无从下手。
  const live = new Map(
    citations.filter((c) => (c.via ?? CONCLUSION_VIA) === CONCLUSION_VIA).map((c) => [c.url, c.title ?? ""]),
  );
  const out: Array<{ title: string; url: string }> = [];
  for (const c of checks) {
    if (linkVerdict(c) !== "dead") continue;
    const title = live.get(c.url);
    if (title === undefined) continue;
    out.push({ title: title === "" ? c.url : title, url: c.url });
  }
  return out;
}

/** 修订素材计数：按钮文案与提示用 */
export function revisionCounts(
  items: RevisionItem[],
  deadLinks = 0,
): {
  total: number;
  replace: number;
  unresolved: number;
  drop: number;
  narrow: number;
  mark: number;
  deadLinks: number;
} {
  const unresolved = items.filter((i) => i.verdict === "candidate" || i.verdict === "empty");
  return {
    total: items.length,
    replace: items.filter((i) => i.verdict === "matched").length,
    unresolved: unresolved.length,
    drop: unresolved.filter((i) => unresolvedAdvice(i) === "drop").length,
    narrow: unresolved.filter((i) => unresolvedAdvice(i) === "narrow").length,
    mark: unresolved.filter((i) => unresolvedAdvice(i) === "mark").length,
    deadLinks,
  };
}
