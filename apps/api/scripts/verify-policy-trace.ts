/**
 * 验证脚本：政策文号溯源（提取 / 归一化 / 三级口径 / 真实任务走查）。
 * 运行：pnpm verify:policytrace
 *（此前写成 verify:policy，那是智研税审政策库的另一项检查——照着跑能过，但根本没验到这个脚本）
 */
import {
  collectRefStrings,
  extractDocRefs,
  METADATA_ONLY_SEARCH_TOOLS,
  normalizeRef,
  RETAINED_TEXT_KEY,
  traceDocRefs,
} from "../../web/src/policy-trace.ts";
import { extractCitations, retainedSourceAt, retainedSourceLines, UNCAPPED } from "../../web/src/search-evidence.ts";
import { db } from "../src/db.ts";
import { getTask, listTasks } from "../src/services/task-store.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

// 1) 归一化与提取
expect("归一化括号与空格", normalizeRef("财税〔2015〕 119 号"), "财税[2015]119号");
expect("归一化中文方括号", normalizeRef("【2015】119号"), "[2015]119号");
expect("提取核心（六角括号）", extractDocRefs("按财税〔2015〕119号执行")[0]?.core, "[2015]119号");
expect("提取核心（半角括号 + 空格）", extractDocRefs("见财税[2015] 119 号")[0]?.core, "[2015]119号");
expect("提取公告类文号", extractDocRefs("国家税务总局公告2017年第40号")[0]?.core, "2017年第40号");
expect("同一文号多次出现只计一条并记次数", extractDocRefs("财税〔2015〕119号 与 财税〔2015〕119 号")[0]?.occurrences, 2);
expect("不同文号分别提取", extractDocRefs("财税〔2015〕119号、国税发〔2006〕187号").length, 2);
expect("按出现位置排序", extractDocRefs("国税发〔2006〕187号 在前，财税〔2015〕119号 在后").map((r) => r.core), [
  "[2006]187号",
  "[2015]119号",
]);
expect("无文号返回空", extractDocRefs("本段没有任何文号，只有 2025 年度和 100% 比例").length, 0);
expect("空文本返回空", extractDocRefs("").length, 0);
expect("上下文包含文号", extractDocRefs("依据财税〔2015〕119号第六条")[0]?.context.includes("119号"), true);

// 2) 三级口径
const results = [{ policies: [{ docNumber: "财税[2015]119号", ratio: 100 }] }];
expect("写法不同也能匹配（归一化后包含）", traceDocRefs("按财税〔2015〕119 号执行", results).traced, 1);
expect("无出处且未用联网检索 → 待确认", traceDocRefs("按国税发〔2006〕187号执行", results).untraced.length, 1);
expect(
  "无出处但用过 web_search → 无法核验",
  traceDocRefs("按国税发〔2006〕187号执行", results, ["web_search"]).unverifiable,
  1,
);
expect(
  "无法核验时不再列为待确认",
  traceDocRefs("按国税发〔2006〕187号执行", results, ["fetch_content"]).untraced.length,
  0,
);
expect("三类之和等于总数", (() => {
  const r = traceDocRefs("财税〔2015〕119号 与 国税发〔2006〕187号", results, ["web_search"]);
  return r.traced + r.unverifiable + r.untraced.length === r.total;
})(), true);

// 2.5) 复查取得的出处同样是出处
expect(
  "复查 matched 的文号计入有出处",
  traceDocRefs("按国税发〔2006〕187号执行", results, [], ["国税发〔2006〕187 号"]).traced,
  1,
);
expect(
  "复查取得的出处单独计数",
  traceDocRefs("按国税发〔2006〕187号执行", results, [], ["国税发[2006]187号"]).tracedByRecheck,
  1,
);
expect(
  "工具留存已有的不重复计入复查取得",
  traceDocRefs("按财税〔2015〕119号执行", results, [], ["财税[2015]119号"]).tracedByRecheck,
  0,
);
expect(
  "复查到出处后不再算无法核验",
  traceDocRefs("按国税发〔2006〕187号执行", results, ["web_search"], ["国税发〔2006〕187号"]).unverifiable,
  0,
);
expect(
  "复查记录为空时与旧口径一致",
  traceDocRefs("按国税发〔2006〕187号执行", results, [], []).untraced.length,
  1,
);
expect(
  "两个文号一个来自留存一个来自复查",
  (() => {
    const r = traceDocRefs("财税〔2015〕119号 与 国税发〔2006〕187号", results, [], ["国税发[2006]187号"]);
    return r.traced === 2 && r.tracedByRecheck === 1 && r.total === 2;
  })(),
  true,
);
expect("元数据检索工具清单", [...METADATA_ONLY_SEARCH_TOOLS].sort(), ["fetch_content", "web_search"]);

// 3) 真实任务走查：三级口径必须自洽
let total = 0;
let traced = 0;
let byRecheck = 0;
let byBody = 0;
let bodyWithUrl = 0;
let bodyUrlViaLine = 0;
let unverifiable = 0;
let untraced = 0;
for (const t of listTasks()) {
  const detail = getTask(t.id);
  const text = detail?.result ?? "";
  if (!text.trim()) continue;
  const rows = db.prepare(`SELECT tool_name, result, ok FROM tool_calls WHERE task_id = ?`).all(t.id) as Array<{
    tool_name: string;
    result: string | null;
    ok: number | null;
  }>;
  const parsed = rows
    .filter((r) => r.ok === 1)
    .map((r) => {
      try {
        return r.result ? JSON.parse(r.result) : null;
      } catch {
        return null;
      }
    });
  // 与看板、结果页、证据表同一口径：复查判定 matched 的文号也算有出处
  const rechecked = (
    db
      .prepare(`SELECT text FROM ref_checks WHERE task_id = ? AND kind = 'docref' AND verdict = 'matched'`)
      .all(t.id) as Array<{ text: string }>
  ).map((r) => r.text);
  const res = traceDocRefs(text, parsed, rows.map((r) => r.tool_name), rechecked);
  checks += 1;
  if (res.traced + res.unverifiable + res.untraced.length !== res.total) {
    failures.push(`${t.id} 文号三级口径之和 ${res.traced + res.unverifiable + res.untraced.length} ≠ 总数 ${res.total}`);
  }
  checks += 1;
  if (res.tracedByRecheck > res.traced) {
    failures.push(`${t.id} 复查取得的出处 ${res.tracedByRecheck} 超过有出处总数 ${res.traced}`);
  }
  checks += 1;
  if (res.tracedByBody + res.tracedByRecheck > res.traced) {
    failures.push(`${t.id} 两档弱依据 ${res.tracedByBody}+${res.tracedByRecheck} 超过有出处总数 ${res.traced}`);
  }
  checks += 1;
  if (res.bodyTracedRefs.length !== res.tracedByBody) {
    failures.push(`${t.id} 仅正文提到的明细 ${res.bodyTracedRefs.length} 条与计数 ${res.tracedByBody} 不一致`);
  }
  for (const r of res.bodyTracedRefs) {
    if (r.sourceUrl !== "") bodyWithUrl += 1;
    if (r.sourceVia === "body-line") bodyUrlViaLine += 1;
    checks += 1;
    if (r.sourceCount < 1) failures.push(`${t.id} 文号 ${r.text} 的留存正文命中份数 ${r.sourceCount} < 1`);
    checks += 1;
    if ((r.sourceUrl !== "") !== (r.sourceVia !== "")) {
      failures.push(`${t.id} 文号 ${r.text} 的地址与依据档位不一致（url=${r.sourceUrl} via=${r.sourceVia}）`);
    }
  }
  total += res.total;
  traced += res.traced;
  byRecheck += res.tracedByRecheck;
  byBody += res.tracedByBody;
  unverifiable += res.unverifiable;
  untraced += res.untraced.length;
}
console.log(
  `[verify] 真实文号=${total} 有出处=${traced}（元数据=${traced - byBody - byRecheck} · 仅留存正文=${byBody}（其中 ${bodyWithUrl} 处带可点开的原文地址） · 复查取得=${byRecheck}）无法核验=${unverifiable} 待确认=${untraced}`,
);
// 地址归属这条路径必须真的被走到，而不是「碰巧每处都有结构化地址、这段代码从未执行」。
// 第一条断言同时兼作「确实检查到了东西」：空库或结论里没有文号时 byBody 为 0，它就红，不会空跑绿。
expect("确实走到了「仅正文提到」这一档", byBody >= 1, true);
expect("每一处「仅正文提到」都能点开原文", bodyWithUrl, byBody);
expect("其中至少一处的地址只能来自留存正文的来源行", bodyUrlViaLine >= 1, true);
console.log(
  `[verify] 仅正文提到 ${byBody} 处的地址依据：结构化字段 ${bodyWithUrl - bodyUrlViaLine} · 正文来源行 ${bodyUrlViaLine}`,
);
// 留存正文参与文号溯源：这是一次**有意的语义放宽**，必须用断言钉住。
// agent-factory 给联网类工具留存了网页正文（retainedText），而 collectRefStrings 是通用字符串遍历，
// 于是「文号有出处」的判据从「出现在标题/地址等元数据里」放宽成「出现在我们真的抓下来的页面正文里」。
// 方向是对的——实测 H 任务 2 处文号里「2023年第8号」只靠留存正文才溯到，此前会被判成无出处，
// 那是假阴性：页面确实在手上，比「检索摘要里出现过」更强（复查机制本来就接受后者）。
// 但放宽就得写明并守住，否则哪天被顺手改回去、或改过头把无关页面也算进来，都不会有人发现。
const META_ONLY = {
  url: "https://fgk.chinatax.gov.cn/zcfgk/c100012/c5206772/content.html",
  // 标题带文号是常见形态，这样两处文号里一处靠元数据、一处只能靠正文，增量效果才分得开
  title: "国家税务总局公告2021年第28号 关于进一步落实研发费用加计扣除政策有关问题的公告",
  charCount: 3000,
};
const BODY_TEXT =
  "……另据《国家税务总局关于公布全文和部分条款失效废止的税务规范性文件目录的公告》（2023年第8号），第一条失效。";
const WITH_BODY = { ...META_ONLY, retainedText: BODY_TEXT, retainedChars: BODY_TEXT.length, omittedChars: 0 };
const CONCLUSION = "依据 2023年第8号 公告，2021年第28号公告第一条失效。";
expect(
  "只有元数据时，仅出现在正文里的文号溯不到（这就是此前的假阴性）",
  traceDocRefs(CONCLUSION, [META_ONLY], ["fetch_public_document"]).traced,
  1, // 2021年第28号 在标题里，2023年第8号 不在
);
expect(
  "留存正文后两处文号都能溯源",
  traceDocRefs(CONCLUSION, [WITH_BODY], ["fetch_public_document"]).traced,
  2,
);
expect(
  "留存正文不改变文号总数，只影响能否溯到",
  traceDocRefs(CONCLUSION, [WITH_BODY], ["fetch_public_document"]).total,
  2,
);
// 依据分档：元数据 > 留存正文 > 联网复查，一条文号只算在它最强的那一档上，三个数相加恒等于 traced
expect(
  "只有元数据时「仅正文提到」为 0",
  traceDocRefs(CONCLUSION, [META_ONLY], ["fetch_public_document"]).tracedByBody,
  0,
);
expect(
  "留存正文后，只靠正文溯到的那一处单独计数",
  traceDocRefs(CONCLUSION, [WITH_BODY], ["fetch_public_document"]).tracedByBody,
  1, // 2023年第8号 只在正文里；2021年第28号 在标题（元数据）里
);
expect(
  "元数据里也有的文号不算「仅正文提到」",
  traceDocRefs(
    CONCLUSION,
    [{ ...WITH_BODY, retainedText: `${BODY_TEXT} 另见 2021年第28号 公告。` }],
    ["fetch_public_document"],
  ).tracedByBody,
  1,
);
expect(
  "正文里已溯到的文号不再算「复查取得」",
  traceDocRefs(CONCLUSION, [WITH_BODY], ["fetch_public_document"], ["2023年第8号"]).tracedByRecheck,
  0,
);
const SPLIT = traceDocRefs(CONCLUSION, [WITH_BODY], ["fetch_public_document"], ["2023年第8号"]);
expect(
  "两档弱依据相加不超过有出处总数（不会重复计数）",
  SPLIT.tracedByBody + SPLIT.tracedByRecheck <= SPLIT.traced,
  true,
);
// 明细与计数必须同源：只给数字，复核人还是不知道该点开哪一条
expect(
  "「仅正文提到」的明细就是那一处只靠正文溯到的文号",
  traceDocRefs(CONCLUSION, [WITH_BODY], ["fetch_public_document"]).bodyTracedRefs.map((r) => r.text),
  ["2023年第8号"],
);
expect(
  "明细里的文号确实不在元数据池里（否则就该算元数据那一档）",
  traceDocRefs(CONCLUSION, [WITH_BODY], ["fetch_public_document"]).bodyTracedRefs.every(
    (r) => !collectRefStrings([WITH_BODY], "meta").some((s) => s.includes(r.core)),
  ),
  true,
);
expect(
  "明细带上下文，复核人能看出结论里是怎么写的",
  traceDocRefs(CONCLUSION, [WITH_BODY], ["fetch_public_document"]).bodyTracedRefs.every((r) => r.context.length > 0),
  true,
);
expect(
  "只有元数据时明细为空",
  traceDocRefs(CONCLUSION, [META_ONLY], ["fetch_public_document"]).bodyTracedRefs.length,
  0,
);
// 这一档要能**行动**：只给计数，复核人还是不知道去点哪一页确认文号是主题还是被顺带提到
expect(
  "明细带上留存正文所属页面地址",
  traceDocRefs(CONCLUSION, [WITH_BODY], ["fetch_public_document"]).bodyTracedRefs.map((r) => r.sourceUrl),
  [META_ONLY.url],
);
expect(
  "同时带标题，交付 MD 里能写成可读的链接",
  traceDocRefs(CONCLUSION, [WITH_BODY], ["fetch_public_document"]).bodyTracedRefs[0]?.sourceTitle.includes(
    "2021年第28号",
  ),
  true,
);
expect(
  "结果里没有可归属的地址时给空串，不硬凑一个",
  traceDocRefs(CONCLUSION, [{ retainedText: BODY_TEXT }], ["fetch_public_document"]).bodyTracedRefs.map(
    (r) => r.sourceUrl,
  ),
  [""],
);
expect(
  "地址不属于元数据那一档：只在元数据里命中的文号不进明细",
  traceDocRefs(CONCLUSION, [WITH_BODY], ["fetch_public_document"]).bodyTracedRefs.every(
    (r) => !collectRefStrings([WITH_BODY], "meta").some((s) => s.includes(r.core)),
  ),
  true,
);
// 归属要挑对那一份：同一文号常在多份留存正文里都出现，而 web_search 那类只留查询词、结果里没有
// 地址。第一版按下标取第一个命中，实测两处「仅正文提到」都先撞上 web_search，地址全空——
// 复核人还是点不开原文，这一档就仍只是个装饰性数字。
const MIXED_BODY = [
  { queries: ["研发费用加计扣除"], retainedText: BODY_TEXT }, // web_search 的形状：有正文、没地址
  { url: "https://gov.cn/a.html", title: "官方解读", retainedText: BODY_TEXT },
];
expect(
  "多份正文都提到时归属到带地址的那份",
  traceDocRefs(CONCLUSION, MIXED_BODY, ["web_search", "fetch_public_document"]).bodyTracedRefs.map((r) => r.sourceUrl),
  ["https://gov.cn/a.html"],
);
expect(
  "并报出命中份数（多份互不相关的来源同时提到，比一份更站得住）",
  traceDocRefs(CONCLUSION, MIXED_BODY, ["web_search", "fetch_public_document"]).bodyTracedRefs.map(
    (r) => r.sourceCount,
  ),
  [2],
);
expect(
  "全都不带地址时份数照实给、地址留空",
  traceDocRefs(CONCLUSION, [{ retainedText: BODY_TEXT }], ["web_search"]).bodyTracedRefs.map((r) => [
    r.sourceUrl,
    r.sourceCount,
  ]),
  [["", 1]],
);
// 两池分开遍历、各有一份字符串预算：共用一份时长正文会把元数据挤出预算，
// 出现「元数据里明明有，却判成只靠正文才溯到」
expect(
  "meta 池不含留存正文",
  collectRefStrings([WITH_BODY], "meta").some((s) => s.includes(normalizeRef("2023年第8号"))),
  false,
);
expect("body 池只含留存正文", collectRefStrings([WITH_BODY], "body"), [normalizeRef(BODY_TEXT)]);
expect(
  "默认 all 池是两池之和",
  collectRefStrings([WITH_BODY]).length,
  collectRefStrings([WITH_BODY], "meta").length + collectRefStrings([WITH_BODY], "body").length,
);
expect("meta 池仍收得到标题里的文号", collectRefStrings([WITH_BODY], "meta").some((s) => s.includes(normalizeRef("2021年第28号"))), true);
// 键名两边各存一份（agent-core 落库时写、web 侧认键拆池），改了一边不会报错，
// 只会静默退化成「全部算元数据」，所以用静态走查盯着
const here = path.dirname(fileURLToPath(import.meta.url));
const agentFactory = fs.readFileSync(
  path.resolve(here, "..", "..", "..", "packages", "agent-core", "src", "agent-factory.ts"),
  "utf8",
);
expect("agent-factory 仍用同一个键名留存正文", agentFactory.includes(RETAINED_TEXT_KEY), true);
expect("留存正文字段名没有被改窄或改名", RETAINED_TEXT_KEY, "retainedText");
// 反向保险：正文里出现的其它地址不得混进引用清单。extractCitations 走 urlsOfCall，
// 只读 results[] / url / urls[] 三个结构化字段，不对整段 JSON 盲扫——这条断言守住这个前提，
// 否则 18000 字的页面正文里随便一个链接都会变成一条「结论引用」，引用分级与官方来源统计全被污染。
const polluted = {
  ...WITH_BODY,
  retainedText: `${BODY_TEXT} 参见 https://example.com/other 与 https://baike.baidu.com/item/xx 以及 /relative/path`,
};
expect(
  "留存正文里的地址不进引用清单（只认结构化字段）",
  extractCitations([{ toolName: "fetch_public_document", result: polluted }], UNCAPPED).map((c) => c.url),
  [META_ONLY.url],
);

// 文号上下文与金额溯源同一口径：既显示在界面上，也会拼进联网复查的检索词，不能带 Markdown 记号
//（记号混进检索词等于掺噪声，引擎按字面匹配，多两个 ** 就搜不到原文页）。
const CTX_REF =
  "> 根据 **财税〔2015〕119号** 第一条（`search_rd_policy`）与《国家税务总局公告2021年第28号》：限额 100,000.00 元";
const ctxRefs = extractDocRefs(CTX_REF);
expect("确实从带记号的原文里提到了文号", ctxRefs.length > 0, true);
for (const r of ctxRefs) {
  expect(`文号 ${r.text} 的上下文不含粗体记号`, /\*\*/.test(r.context), false);
  expect(`文号 ${r.text} 的上下文不含反引号`, r.context.includes("`"), false);
  expect(`文号 ${r.text} 的上下文不含引用记号`, /(^|\s)>\s/.test(r.context), false);
  expect(`文号 ${r.text} 的每一处上下文同样干净`, r.contexts.some((c) => /(\*\*|`)/.test(c)), false);
}
// 剥记号只针对上下文：文号本身要按正式写法进检索词，不能被顺手改掉。
// 提取出的是文号核心（不含机关代号「财税」），断言按核心写。
expect("文号本身保持原文", ctxRefs.some((r) => r.text.includes("〔2015〕119号")), true);
expect("文号本身不含 Markdown 记号", ctxRefs.every((r) => !/(\*\*|`)/.test(r.text)), true);

// 「仅正文提到」的地址是怎么归属出来的：web_search 的结构化字段只有查询词，地址写在留存正文里
// 每条结果末尾的 `Source: 标题 (地址)` 一行。四条判据钉在这里：往后找（不是往前）、检索词行不归属、
// 跨小节不归属、认不出就留空。样例照实测那份正文的形状写（含 Providers 行、## Query 段、结果段）。
const WS_BODY = [
  "**Providers used:** Query 1: exa; Query 2: exa",
  "",
  '## Query: "国家税务总局公告2021年第28号 解读"',
  "",
  "解读页_国家税务总局 为进一步落实研发费用加计扣除政策…… 现解读如下： …… 答：主要包括三项内容",
  "Source: 关于《国家税务总局公告2021年第28号》的解读_国家税务总局 (https://www.chinatax.gov.cn/a.html)",
  "",
  "公告全文 - 中瑞财税信息网站 注：根据2023.05.26国家税务总局公告2023年第8号，本文第一条失效。",
  "Source: 国家税务总局公告2021年第28号 - 中瑞财税信息网站 (http://www.cntax.cn/list_detail/36801.html)",
  "",
  "这段提到财税〔2020〕99号，但它后面紧跟一个新的小节标题，来源行不属于这一段",
  "",
  '## Query: "国税发〔2016〕29号 其他相关费用限额"',
  "",
  "这一条结果的正文，末尾照常带来源行",
  "Source: 无关页面 (https://example.com/none.html)",
  "",
  "最后这段提到财税〔2021〕33号，它后面再没有来源行了",
].join("\n");
const WS_LINES = retainedSourceLines(WS_BODY);
expect("确实从样例正文里认出了来源行", WS_LINES.length, 3);
expect("来源行地址是清洗后的 http(s) 地址", WS_LINES[0]?.url, "https://www.chinatax.gov.cn/a.html");
expect(
  "来源行标题取行内标题、不带记号",
  WS_LINES[1]?.title,
  "国家税务总局公告2021年第28号 - 中瑞财税信息网站",
);
expect("相对地址不算来源行", retainedSourceLines("Source: 标题 (/local/path.html)").length, 0);
expect("没有来源行时一条也不给", retainedSourceLines("只有正文，没有来源行").length, 0);
const atSecond = WS_BODY.indexOf("2023年第8号");
expect("样例里确实取到了命中位置", atSecond > 0, true);
expect(
  "命中在结果正文里 → 归属它后面那条来源行",
  retainedSourceAt(WS_BODY, atSecond)?.url,
  "http://www.cntax.cn/list_detail/36801.html",
);
// 方向反了会归到上一条页面（广东税务/税务总局的解读页），这条断言就是防「往前找」的回归
expect(
  "往前找会归错页，所以判据必须是往后",
  retainedSourceAt(WS_BODY, atSecond)?.url !== "https://www.chinatax.gov.cn/a.html",
  true,
);
expect(
  "命中在第一条结果正文里 → 归属第一条来源行",
  retainedSourceAt(WS_BODY, WS_BODY.indexOf("现解读如下"))?.url,
  "https://www.chinatax.gov.cn/a.html",
);
expect(
  "命中在检索词行里 → 不归属（检索词不属于任何页面）",
  retainedSourceAt(WS_BODY, WS_BODY.indexOf("国税发〔2016〕29号")),
  null,
);
expect(
  "命中与来源行之间隔了新小节 → 不归属（跨段就是猜）",
  retainedSourceAt(WS_BODY, WS_BODY.indexOf("财税〔2020〕99号")),
  null,
);
expect("往后没有来源行 → 不归属", retainedSourceAt(WS_BODY, WS_BODY.indexOf("财税〔2021〕33号")), null);
expect("没有来源行时归属为 null", retainedSourceAt("只有正文，没有来源行", 0), null);

// 接上消费点：上面是纯函数，这里走 traceDocRefs 全链路，确认「仅正文提到」的地址真的能落到界面上
const WS_CALL = {
  queries: ["国家税务总局公告2021年第28号 解读"],
  queryCount: 1,
  searchId: "srch-demo",
  retainedText: WS_BODY,
  retainedChars: WS_BODY.length,
  omittedChars: 0,
};
const wsTrace = traceDocRefs("据国家税务总局公告2023年第8号，本文第一条失效。", [WS_CALL], ["web_search"]);
expect("web_search 留存正文里的文号算「仅正文提到」", wsTrace.tracedByBody, 1);
expect(
  "地址来自正文来源行（结构化字段里一个地址都没有）",
  wsTrace.bodyTracedRefs[0]?.sourceUrl,
  "http://www.cntax.cn/list_detail/36801.html",
);
expect("依据档位如实标成 body-line", wsTrace.bodyTracedRefs[0]?.sourceVia, "body-line");
expect(
  "标题同样来自来源行",
  wsTrace.bodyTracedRefs[0]?.sourceTitle,
  "国家税务总局公告2021年第28号 - 中瑞财税信息网站",
);
expect("结构化字段有地址时优先用它、不被来源行覆盖", traceDocRefs(
  "据国家税务总局公告2023年第8号，本文第一条失效。",
  [{ ...WS_CALL, url: META_ONLY.url, title: "结构化标题" }],
  ["web_search"],
).bodyTracedRefs[0]?.sourceVia, "structured");
const noLine = traceDocRefs(
  "据国家税务总局公告2023年第8号，本文第一条失效。",
  [{ retainedText: "只有正文提到2023年第8号，没有来源行" }],
  ["web_search"],
);
expect("正文里没有来源行 → 地址如实留空", noLine.bodyTracedRefs[0]?.sourceUrl, "");
expect("留空时依据档位也是空", noLine.bodyTracedRefs[0]?.sourceVia, "");
expect("地址留空不影响「有出处」的判定（判据没被放宽也没被收紧）", noLine.tracedByBody, 1);

console.log(`[verify] 文号溯源检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 政策文号溯源规则不符");
  process.exit(1);
}
console.log("[PASS] 政策文号溯源规则正确（提取 / 归一化 / 三级口径 / 真实任务自洽）");
