/**
 * 验证脚本：联网检索留痕与引用提取（各工具结果形状 / 去重与上限 / 元数据检索如实说明 / 真实任务走查）。
 * 运行：pnpm verify:searchev
 */
import {
  CITATION_LIMIT,
  extractCitations,
  extractTextCitations,
  cleanBareUrl,
  isRetiredMention,
  labelFromUrl,
  MERGED_CITATION_LIMIT,
  mergeCitations,
  queriesOfCall,
  retentionNote,
  retentionStats,
  SEARCH_TOOL_NAMES,
  searchEvidence,
  searchEvidenceNote,
  urlsOfCall,
  UNCAPPED,
} from "../../web/src/search-evidence.ts";
import { db } from "../src/db.ts";
import { getTask, listTasks } from "../src/services/task-store.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

function ok(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

/** 政府/税务机关站点（与前端 isOfficialUrl 同口径，这里只用于统计输出） */
function isGov(raw: string): boolean {
  try {
    return new URL(raw).hostname.toLowerCase().endsWith("gov.cn");
  } catch {
    return false;
  }
}

// 1) 各工具结果形状的 URL 提取
expect(
  "search_public_cases 的 results 逐条提取",
  urlsOfCall("search_public_cases", {
    results: [
      { title: "甲", url: "https://a.gov.cn/x/y.html" },
      { title: "", url: "https://b.cn/z" },
    ],
  }),
  [
    { url: "https://a.gov.cn/x/y.html", title: "甲" },
    { url: "https://b.cn/z", title: "https://b.cn/z" },
  ],
);
expect(
  "fetch_content 单地址沿用标题",
  urlsOfCall("fetch_content", { urls: ["https://fgk.chinatax.gov.cn/a.html"], title: "国家税务总局政策法规库" }),
  [{ url: "https://fgk.chinatax.gov.cn/a.html", title: "国家税务总局政策法规库" }],
);
expect(
  "fetch_content 多地址时标题不可归属，退回地址",
  urlsOfCall("fetch_content", { urls: ["https://x.cn/1", "https://x.cn/2"], title: "共用标题" }).map((u) => u.title),
  ["https://x.cn/1", "https://x.cn/2"],
);
expect(
  "fetch_public_document 的单条 url",
  urlsOfCall("fetch_public_document", { url: "https://y.cn/doc", title: "文档" }),
  [{ url: "https://y.cn/doc", title: "文档" }],
);
expect(
  "web_search 只留元数据，提不出 URL",
  urlsOfCall("web_search", { queries: ["q"], totalResults: 15, searchId: "s1" }),
  [],
);
expect("非 http 地址被拒绝", urlsOfCall("search_public_cases", { results: [{ url: "ftp://x/y" }] }), []);
expect("相对地址被拒绝", urlsOfCall("search_public_cases", { results: [{ url: "/a/b.html" }] }), []);
expect("结果为空时安全返回", urlsOfCall("search_public_cases", null), []);
expect("结果不是对象时安全返回", urlsOfCall("web_search", "字符串结果"), []);

// 2) 检索词与 provider
expect(
  "web_search 的检索词与 provider",
  queriesOfCall({
    queries: ["甲", "乙"],
    queryProviders: [
      { query: "甲", providers: ["exa"] },
      { query: "丙", providers: ["exa", "bocha"] },
    ],
  }),
  { queries: ["甲", "乙", "丙"], providers: ["exa", "bocha"] },
);
expect("search_public_cases 的单个检索词", queriesOfCall({ query: " 研发费用 加计扣除 " }).queries, ["研发费用 加计扣除"]);
expect("空结果的检索词为空", queriesOfCall(null).queries, []);

// 3) 引用清单：去重、上限、来源工具、非检索工具忽略
const calls = [
  { toolName: "search_public_cases", result: { query: "q1", results: [{ title: "A", url: "https://a.cn/1" }] } },
  { toolName: "search_public_cases", result: { query: "q1", results: [{ title: "A 重复", url: "https://a.cn/1" }] } },
  { toolName: "fetch_content", result: { urls: ["https://fgk.chinatax.gov.cn/a.html"], title: "政策法规库", totalResults: 0 } },
  { toolName: "web_search", result: { queries: ["q2"], queryProviders: [{ query: "q2", providers: ["exa"] }], totalResults: 15 } },
  { toolName: "generate_workpaper", result: { url: "https://不该被采集.cn/x" } },
];
expect("按 URL 去重", extractCitations(calls).length, 2);
expect("首次出现的标题胜出", extractCitations(calls)[0]?.title, "A");
expect("记录来源工具", extractCitations(calls).map((c) => c.via), ["search_public_cases", "fetch_content"]);
expect("非检索工具不采集", extractCitations(calls).some((c) => c.url.includes("不该被采集")), false);
expect("上限可配置", extractCitations(calls, 1).length, 1);
expect("默认上限", CITATION_LIMIT, 20);

// 4) 检索留痕汇总
const ev = searchEvidence(calls);
expect("检索调用数只算检索类工具", ev.calls, 4);
expect("留下来源的调用数", ev.withUrls, 3);
expect("只留元数据的调用数", ev.metadataOnly, 1);
expect("两类之和等于调用数", ev.withUrls + ev.metadataOnly, ev.calls);
expect("自报命中数累计", ev.reportedResults, 15);
expect("检索词去重", ev.queries, ["q1", "q2"]);
expect("provider 去重", ev.providers, ["exa"]);
expect("工具名清单", ev.tools.sort(), ["fetch_content", "search_public_cases", "web_search"]);
expect("无检索时全为 0", searchEvidence([]).calls, 0);
expect("检索词最多 12 条", searchEvidence(
  Array.from({ length: 20 }, (_, i) => ({ toolName: "web_search", result: { queries: [`q${i}`] } })),
).queries.length, 12);
expect("工具名清单属于已知集合", ev.tools.every((t) => SEARCH_TOOL_NAMES.has(t)), true);

// 5) 「没有引用清单」的如实说明
expect("有引用时不需要说明", searchEvidenceNote(ev, 2), null);
expect("没有检索时不需要说明", searchEvidenceNote(searchEvidence([]), 0), null);
expect("有来源却没提取到引用时不需要说明", searchEvidenceNote({ ...ev, metadataOnly: 0 }, 0), null);
const note = searchEvidenceNote(
  searchEvidence([{ toolName: "web_search", result: { queries: ["土增清算 口径"], totalResults: 18, queryProviders: [{ query: "土增清算 口径", providers: ["exa"] }] } }]),
  0,
);
ok("元数据检索给出说明", typeof note === "string" && note.length > 0, String(note));
ok("说明含调用次数", (note ?? "").includes("1 次联网检索"), note ?? "");
ok("说明含自报命中数", (note ?? "").includes("18 条"), note ?? "");
ok("说明含工具名", (note ?? "").includes("web_search"), note ?? "");
ok("说明含检索词", (note ?? "").includes("土增清算 口径"), note ?? "");
ok("说明给出处置建议", (note ?? "").includes("请在结论中附检索词"), note ?? "");

// 5a) 留存正文的截断量：两层截断，此前 apps/web 里零消费者，平台一层都报不出来
const rc = (toolName: string, retainedChars: number, omittedChars: number): { toolName: string; result: unknown } => ({
  toolName,
  result: { retainedText: "正文", retainedChars, omittedChars },
});
expect("非联网类工具不计入（留存只发生在联网类工具上）", retentionStats([rc("generate_workpaper", 100, 50)]).retainedCalls, 0);
expect(
  "没有留存正文的调用不计入留存层（运行在留存上线之前）",
  retentionStats([{ toolName: "web_search", result: { totalResults: 3 } }]).retainedCalls,
  0,
);
expect(
  "留存层截断逐项汇总，单条最多另记",
  retentionStats([rc("web_search", 20000, 10610), rc("fetch_content", 20000, 14394), rc("fetch_content", 3459, 0)]),
  {
    retainedCalls: 3,
    truncatedCalls: 2,
    retainedChars: 43459,
    omittedChars: 25004,
    maxOmitted: 14394,
    toolTruncatedCalls: 0,
    toolTruncatedNoBody: 0,
    toolOmittedChars: 0,
  },
);
// 工具层必须在「有没有留存正文」之前判：实测 22 条工具层截断里 20 条根本没有正文字段，
// 先按正文过滤的话这一层一条都数不出来，而那恰恰是丢失最严重的一层。
expect(
  "工具自报截断且没留住正文：只计工具层，不误记成留存层",
  retentionStats([{ toolName: "web_search", result: { truncated: true, omittedChars: 10610, queries: ["土增清算"] } }]),
  {
    retainedCalls: 0,
    truncatedCalls: 0,
    retainedChars: 0,
    omittedChars: 0,
    maxOmitted: 0,
    toolTruncatedCalls: 1,
    toolTruncatedNoBody: 1,
    toolOmittedChars: 0,
  },
);
expect(
  "两层同时截断时各算各的，工具层字数只取源头保留的那一份",
  retentionStats([
    {
      toolName: "fetch_content",
      result: { retainedText: "正文", retainedChars: 20000, omittedChars: 10173, truncated: true, toolOmittedChars: 6745 },
    },
  ]),
  {
    retainedCalls: 1,
    truncatedCalls: 1,
    retainedChars: 20000,
    omittedChars: 10173,
    maxOmitted: 10173,
    toolTruncatedCalls: 1,
    toolTruncatedNoBody: 0,
    toolOmittedChars: 6745,
  },
);
expect(
  "历史行里工具层字数被我们盖掉过，不推算（宁可留空也不猜）",
  retentionStats([
    { toolName: "web_search", result: { retainedText: "正文", retainedChars: 20000, omittedChars: 10173, truncated: true } },
  ]).toolOmittedChars,
  0,
);
expect(
  "两层都没截断就不给说明（不为了显示而显示）",
  retentionNote({
    retainedCalls: 3,
    truncatedCalls: 0,
    retainedChars: 100,
    omittedChars: 0,
    maxOmitted: 0,
    toolTruncatedCalls: 0,
    toolTruncatedNoBody: 0,
    toolOmittedChars: 0,
  }),
  null,
);
const rNote = retentionNote({
  retainedCalls: 16,
  truncatedCalls: 1,
  retainedChars: 51107,
  omittedChars: 10173,
  maxOmitted: 10173,
  toolTruncatedCalls: 4,
  toolTruncatedNoBody: 3,
  toolOmittedChars: 0,
});
ok("说明里给出工具层截断次数", (rNote ?? "").includes("联网工具自己截断了 4 次返回内容"), rNote ?? "");
ok("说明里给出连正文都没留住的次数", (rNote ?? "").includes("其中 3 次连正文都没能留存"), rNote ?? "");
ok("说明里给出留存层截断的条数与字数", (rNote ?? "").includes("平台留存时又截断 1 条、合计 10173 字没有存下"), rNote ?? "");
ok("说明交代工具层字数不推算", (rNote ?? "").includes("只报条数、不推算字数"), rNote ?? "");
ok("说明只说核对不到，不断言引文一定丢了", (rNote ?? "").includes("平台核对不到"), rNote ?? "");
const oursOnly = retentionNote({
  retainedCalls: 2,
  truncatedCalls: 1,
  retainedChars: 20000,
  omittedChars: 500,
  maxOmitted: 500,
  toolTruncatedCalls: 0,
  toolTruncatedNoBody: 0,
  toolOmittedChars: 0,
});
expect("只有留存层截断时不提工具层", (oursOnly ?? "").includes("联网工具自己截断"), false);
expect("只有留存层截断时不写工具层那句字数口径", (oursOnly ?? "").includes("不推算字数"), false);
expect("只有留存层截断时照样给出条数与字数", (oursOnly ?? "").includes("平台留存时又截断 1 条、合计 500 字没有存下"), true);
/**
 * 两条负向断言的判据模式。提到具名常量上是为了让阳性对照与判据用**同一个 RegExp 对象**——
 * 另打一份字面量去自检等于没检，两份会各自漂。
 * MD_NOTE_MARK 管界面纯文本展示位，MD_TITLE_MARK 管从正文提取出来的引用标题。
 */
const MD_NOTE_MARK = /[#*`|>]/;
const MD_TITLE_MARK = /(\*\*|`)/;
// 阳性对照：这两条的断言方向都是「不得命中」，模式写废就永远绿，绿的样子与「文案确实干净」
// 一模一样。逐类记号各断一次它确实能命中。
expect("「说明不含记号」的模式确实能命中井号", MD_NOTE_MARK.test("## 结论"), true);
expect("「说明不含记号」的模式确实能命中粗体记号", MD_NOTE_MARK.test("差额 **454 元**"), true);
expect("「说明不含记号」的模式确实能命中反引号与竖线", MD_NOTE_MARK.test("`a` | b"), true);
expect("「说明不含记号」的模式确实能命中引用记号", MD_NOTE_MARK.test("> 引自"), true);
expect("「标题不含记号」的模式确实能命中粗体记号", MD_TITLE_MARK.test("**标题**"), true);
expect("「标题不含记号」的模式确实能命中反引号", MD_TITLE_MARK.test("见 `表A`"), true);
// 这句话在界面上是纯文本展示位，带记号就会以原文显示出来
expect("说明不含 Markdown 记号", MD_NOTE_MARK.test(rNote ?? ""), false);

// 5b) 结论正文里的引用提取与两来源合并
expect("markdown 链接取链接文字", extractTextCitations("见[政策执行指引](https://a.gov.cn/x.pdf)。")[0], {
  title: "政策执行指引",
  url: "https://a.gov.cn/x.pdf",
  via: "conclusion",
});
expect(
  "裸链接末段无意义时用域名兜底",
  extractTextCitations("依据 https://fgk.chinatax.gov.cn/zcfgk/c1/content.html 执行")[0]?.title,
  "fgk.chinatax.gov.cn",
);
expect(
  "裸链接末段有意义时用文件名",
  extractTextCitations("https://a.cn/p/研发费用指引.html")[0]?.title,
  "研发费用指引.html",
);
expect("去掉结尾句读", extractTextCitations("见 https://a.cn/x.html。")[0]?.url, "https://a.cn/x.html");
expect("去掉结尾全角括号", extractTextCitations("（https://a.cn/x.html）")[0]?.url, "https://a.cn/x.html");
// 裸地址一路吞到空白为止，会把后面的中文说明整段当成地址：实测「…content.html（检索时间 2026-09-29」
// 与「…content.html／2026-09-29」都进了引用清单，核验必然 404，还把同一个原文页重复计成两条
expect(
  "全角括号处截断，不把检索时间说明吞进地址",
  extractTextCitations("原文页 http://fgk.chinatax.gov.cn/zcfgk/c100012/c5193854/content.html（检索时间 2026-09-29）")[0]
    ?.url,
  "http://fgk.chinatax.gov.cn/zcfgk/c100012/c5193854/content.html",
);
expect(
  "全角斜杠也是终止符",
  extractTextCitations("http://fgk.chinatax.gov.cn/zcfgk/c1/content.html／2026-09-29")[0]?.url,
  "http://fgk.chinatax.gov.cn/zcfgk/c1/content.html",
);
ok(
  "截断后路径仍以 /content.html 结尾，分级才认得出是政策法规库原文页",
  (extractTextCitations("见 http://fgk.chinatax.gov.cn/zcfgk/c1/content.html（检索时间 2026-09-29）")[0]?.url ?? "").endsWith(
    "/content.html",
  ),
  extractTextCitations("见 http://fgk.chinatax.gov.cn/zcfgk/c1/content.html（检索时间 2026-09-29）")[0]?.url,
);
expect(
  "同一条地址带尾巴与不带尾巴只算一条",
  extractTextCitations("http://a.cn/x.html 与 http://a.cn/x.html（检索时间 2026-09-29）").length,
  1,
);
expect(
  "路径里未转义的中文不被截断（这是真实存在的写法，不能一刀切按非 ASCII 截）",
  extractTextCitations("https://a.cn/p/研发费用指引.html")[0]?.url,
  "https://a.cn/p/研发费用指引.html",
);
expect(
  "百分号转义的中文地址不受影响",
  extractTextCitations("https://baike.baidu.com/item/%E7%A0%94%E5%8F%91/4815440")[0]?.url,
  "https://baike.baidu.com/item/%E7%A0%94%E5%8F%91/4815440",
);
// 正文交代「这条已作废」时提到的地址不算当前引用：模型按修订指令撤下失效链接后会留一句说明，
// 那句说明里的地址若仍被当成引用，失效链接就永远挂在待办与交付自检里，修一次报一次
const retiredText =
  "说明二：**原引用的国家税务总局网站「即问即答」页面 https://www.chinatax.gov.cn/chinatax/n810356/c5185946/content.html 经服务端 GET 核验返回 4xx，已判定失效，不再作为依据地址保留**；本轮改以 https://www.gov.cn/zhengce/jiedu/live.html 替代。";
expect("已作废交代里的地址不进引用清单，替代地址照常进", extractTextCitations(retiredText).map((c) => c.url), [
  "https://www.gov.cn/zhengce/jiedu/live.html",
]);
expect(
  "作废字样在窗口内才判为已作废",
  isRetiredMention("原引用的页面 https://a.gov.cn/x.html", "原引用的页面 https://a.gov.cn/x.html".indexOf("https://")),
  true,
);
expect(
  "正常引用不被误判为已作废（检索时间一类附注不含作废字样）",
  extractTextCitations("政策依据见 https://fgk.chinatax.gov.cn/zcfgk/c1/content.html（检索时间 2026-09-30）").map(
    (c) => c.url,
  ),
  ["https://fgk.chinatax.gov.cn/zcfgk/c1/content.html"],
);
// 作废交代也可能写在地址**后面**：实测替换映射表那一行是「| 19 | 标题 https://…c5185946/content.html
// （服务端 GET 返回 4xx，地址已失效） | 替代标题 | https://gov.cn/… |」。只往前看会漏掉它，
// 已经换好的地址又被列进修订指令，模型白跑一轮（实测：写回续跑 300 秒后同一条失效地址仍挂在引用表里）
const mappingRow =
  "| 19 | 研发费用税前加计扣除政策即问即答_国家税务总局 https://www.chinatax.gov.cn/chinatax/n810356/n3010387/c5185946/content.html（**服务端 GET 返回 4xx，地址已失效**） | 《即问即答_政策解读_中国政府网》 | https://www.gov.cn/zhengce/2023-04/02/content_5749772.htm | 2026-09-29 |";
expect(
  "映射行里写在地址后面的失效说明也认得，只留替代地址",
  extractTextCitations(mappingRow).map((c) => c.url),
  ["https://www.gov.cn/zhengce/2023-04/02/content_5749772.htm"],
);
expect(
  "往后看到下一条地址即止，不把别的地址的失效说明算到前一条头上",
  extractTextCitations("现行有效页 https://a.gov.cn/live.html | 注：旧页 https://a.gov.cn/old.html 已失效").map(
    (c) => c.url,
  ),
  ["https://a.gov.cn/live.html"],
);
expect(
  "往后看遇换行即止，下一段的失效说明不影响上一行引用",
  extractTextCitations("依据 https://a.gov.cn/p.html\n（另：某门户同栏目页面存在已失效情形）").map((c) => c.url),
  ["https://a.gov.cn/p.html"],
);
expect(
  "写在地址后面的失效说明在窗口内即判为已作废",
  isRetiredMention("https://a.gov.cn/x.html（地址已失效）", 0, "https://a.gov.cn/x.html".length),
  true,
);
expect("不传地址长度时只往前看，保持既有调用口径", isRetiredMention("https://a.gov.cn/x.html 已失效", 0), false);
expect("同一地址只留一条", extractTextCitations("https://a.cn/x 与 https://a.cn/x").length, 1);
expect("markdown 链接优先于裸链接", extractTextCitations("[标题](https://a.cn/x) https://a.cn/x")[0]?.title, "标题");
expect("表格里的链接也能取到", extractTextCitations("| 依据 | [文号](https://a.gov.cn/y) |").length, 1);
expect("空文本返回空", extractTextCitations("").length, 0);
expect(
  "正文提取上限生效",
  extractTextCitations(Array.from({ length: 25 }, (_, i) => `https://a.cn/${i}`).join(" "), 20).length,
  20,
);
expect("非 http 地址不取", extractTextCitations("ftp://a.cn/x 与 file:///tmp/a").length, 0);
expect(
  "labelFromUrl 坏地址原样返回",
  labelFromUrl("不是网址"),
  "不是网址",
);
const fromTools = [{ title: "工具标题", url: "https://a.cn/1", via: "search_public_cases" }];
const fromText = [
  { title: "正文标题", url: "https://a.cn/1", via: "conclusion" },
  { title: "正文独有", url: "https://b.cn/2", via: "conclusion" },
];
expect(
  "合并去重且工具标题优先",
  mergeCitations(fromTools, fromText).map((c) => c.title),
  ["工具标题", "正文独有"],
);
expect(
  "合并保留来源标记",
  mergeCitations(fromTools, fromText).map((c) => c.via),
  ["search_public_cases", "conclusion"],
);
expect(
  "合并上限生效",
  mergeCitations(
    fromTools,
    Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, url: `https://c.cn/${i}`, via: "conclusion" })),
    24,
  ).length,
  24,
);
expect("合并上限默认值大于单来源上限", MERGED_CITATION_LIMIT > CITATION_LIMIT, true);

// 6) 真实任务走查：工具留存与结论正文里的每个 URL 都必须进入合并后的引用清单（除非超过上限）
let taskTotal = 0;
let withSearch = 0;
let metaOnlyCalls = 0;
let citeTotal = 0;
let toolCiteTotal = 0;
let textCiteTotal = 0;
let officialTotal = 0;
for (const t of listTasks()) {
  const rows = db.prepare(`SELECT tool_name, result FROM tool_calls WHERE task_id = ?`).all(t.id) as Array<{
    tool_name: string;
    result: string | null;
  }>;
  const parsed = rows.map((r) => {
    let result: unknown = null;
    try {
      result = r.result ? JSON.parse(r.result) : null;
    } catch {
      result = null;
    }
    return { toolName: r.tool_name, result };
  });
  const cites = extractCitations(parsed);
  const text = getTask(t.id)?.result ?? "";
  const textCites = extractTextCitations(text);
  const merged = mergeCitations(cites, textCites);
  // 完整性断言用全量清单：带上限的那份是给界面胶囊用的。一旦某一侧被截断（实测 aabd138a 结论里的
  // URL 超过 20 条），排在截断线之外的地址就不在清单里，而合并总数仍未触顶、守卫照样放行，
  // 于是把「显示截断」误报成「提取漏项」。度量按全量、显示才截断，这条口径在验证脚本里同样适用
  const citesAll = extractCitations(parsed, UNCAPPED);
  const textCitesAll = extractTextCitations(text, UNCAPPED);
  const mergedAll = mergeCitations(citesAll, textCitesAll, UNCAPPED);
  const evidence = searchEvidence(parsed);
  taskTotal += 1;
  // 走查报的数也用全量：这行日志会进验证记录，与看板对不上就会被当成两处口径打架
  citeTotal += mergedAll.length;
  toolCiteTotal += citesAll.length;
  textCiteTotal += textCitesAll.length;
  officialTotal += mergedAll.filter((c) => isGov(c.url)).length;
  if (evidence.calls > 0) withSearch += 1;
  metaOnlyCalls += evidence.metadataOnly;
  checks += 1;
  if (evidence.calls !== evidence.withUrls + evidence.metadataOnly) {
    failures.push(`${t.id.slice(0, 8)} 检索留痕两类之和不等于调用数`);
  }
  if (merged.length > MERGED_CITATION_LIMIT) failures.push(`${t.id.slice(0, 8)} 合并后的引用清单超过上限`);
  // 每个留存过 URL 的检索调用都必须被计入 withUrls，且其地址出现在全量清单里
  for (const c of parsed) {
    if (!SEARCH_TOOL_NAMES.has(c.toolName)) continue;
    const urls = urlsOfCall(c.toolName, c.result).map((u) => u.url);
    if (urls.length === 0) continue;
    for (const u of urls) {
      checks += 1;
      if (!citesAll.some((x) => x.url === u)) {
        failures.push(`${t.id.slice(0, 8)} 留存的 URL 未进入引用清单：${u.slice(0, 80)}`);
      }
    }
  }
  // 结论正文里出现的每条 URL 都必须进入合并后的全量清单：否则引用核验与证据力分级都覆盖不到它
  for (const m of text.matchAll(/https?:\/\/[^\s)\]>"'|，。；、]+/g)) {
    // 与提取共用同一份实现：清理规则与「已作废交代」的排除都必须同源。
    // 这里曾自己抄了一套正则，提取口径一改两边就对不上（实测 20 项失败）
    if (isRetiredMention(text, m.index ?? 0, (m[0] ?? "").length)) continue;
    const u = cleanBareUrl(m[0] ?? "");
    checks += 1;
    if (!mergedAll.some((x) => x.url === u)) {
      failures.push(`${t.id.slice(0, 8)} 结论正文的 URL 未进入引用清单：${u.slice(0, 80)}`);
    }
  }
}
console.log(
  `[verify] 真实任务走查：${taskTotal} 个任务 · ${withSearch} 个用过联网检索 · 引用 ${citeTotal} 条（工具留存 ${toolCiteTotal} + 结论正文 ${textCiteTotal}，去重后 ${citeTotal}；政府/税务机关站点 ${officialTotal} 条）· 只留元数据的检索 ${metaOnlyCalls} 次`,
);

// 地址与标题都不能把 Markdown 记号带进界面：引用胶囊只有 260px 宽还要 truncate，记号白占字宽；
// 更严重的是带反引号的地址点开必然 404，链接核验也跟着白跑一次（实测「…content.html`」）。
const MD_CITE = [
  "详见 [`28号公告解读`](https://gov.cn/a.html) 与 [**官方解读**](https://gov.cn/b.html)。",
  "另有裸地址 https://gov.cn/c.html` 与 **https://gov.cn/d.html** 两处。",
].join("\n");
const mdCites = extractTextCitations(MD_CITE, UNCAPPED);
expect("链接文字里的行内代码记号不进标题", mdCites.find((c) => c.url.includes("/a.html"))?.title, "28号公告解读");
expect("链接文字里的粗体记号不进标题", mdCites.find((c) => c.url.includes("/b.html"))?.title, "官方解读");
expect("反引号包住的裸地址，地址本身干净", mdCites.some((c) => c.url === "https://gov.cn/c.html"), true);
expect("粗体包住的裸地址也能提取", mdCites.some((c) => c.url === "https://gov.cn/d.html"), true);
ok(
  "提取出的地址都不带反引号与星号",
  mdCites.every((c) => !c.url.includes("`") && !c.url.includes("*")),
  JSON.stringify(mdCites.map((c) => c.url)),
);
ok(
  "提取出的标题都不带 Markdown 记号",
  mdCites.every((c) => !MD_TITLE_MARK.test(c.title)),
  JSON.stringify(mdCites.map((c) => c.title)),
);
expect("地址尾部的反引号被剥掉", cleanBareUrl("https://gov.cn/a_content.html`"), "https://gov.cn/a_content.html");
expect("地址尾部的星号被剥掉", cleanBareUrl("https://gov.cn/a.html**"), "https://gov.cn/a.html");
// 工具留存那条路径同样要去记号：标题来自工具结果，也可能带着从页面正文抠出来的记号
const toolTitles = urlsOfCall("search_public_cases", {
  results: [{ url: "https://gov.cn/e.html", title: "**《公告》**全文" }],
});
expect("工具留存标题也去记号", toolTitles[0]?.title, "《公告》全文");
expect("标题为空时仍退回地址本身", urlsOfCall("fetch_public_document", { url: "https://gov.cn/f.html" })[0]?.title, "https://gov.cn/f.html");

// 防空跑：检索留痕的真实走查在空库下一条都不跑，纯函数断言照样全绿
expect("确实走到了真实任务（空库不算通过）", listTasks().length >= 1, true);
console.log(`[verify] 检索留痕检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 联网检索留痕规则不符");
  process.exit(1);
}
console.log("[PASS] 联网检索留痕与引用提取正确（各工具形状 / 去重上限 / 元数据检索如实说明 / 真实任务走查）");
