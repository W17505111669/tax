/**
 * 验证脚本：政策文号溯源（提取 / 归一化 / 三级口径 / 真实任务走查）。
 * 运行：pnpm verify:policy
 */
import {
  extractDocRefs,
  METADATA_ONLY_SEARCH_TOOLS,
  normalizeRef,
  traceDocRefs,
} from "../../web/src/policy-trace.ts";
import { extractCitations, UNCAPPED } from "../../web/src/search-evidence.ts";
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
  total += res.total;
  traced += res.traced;
  byRecheck += res.tracedByRecheck;
  unverifiable += res.unverifiable;
  untraced += res.untraced.length;
}
console.log(
  `[verify] 真实文号=${total} 有出处=${traced}（其中复查取得=${byRecheck}）无法核验=${unverifiable} 待确认=${untraced}`,
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

console.log(`[verify] 文号溯源检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 政策文号溯源规则不符");
  process.exit(1);
}
console.log("[PASS] 政策文号溯源规则正确（提取 / 归一化 / 三级口径 / 真实任务自洽）");
