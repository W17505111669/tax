/**
 * 验证脚本：政策文号联网复查（检索词构造 / 四级判定 / 落库往返 / 真实任务走查）。
 * 检索通过注入的假实现离线跑通，不依赖网络。
 * 运行：pnpm verify:refcheck
 */
import type { DetailedSearch, SearchAttempt, WebSearchResult } from "@tax/business-tools";
import {
  buildRefQuery,
  contextKeywords,
  gradeRefCheck,
  pendingAfterRecheck,
  refCheckTargets,
  refKey,
  REF_VERDICT_HINT,
  REF_VERDICT_TEXT,
  refQueryVariants,
  stripSiteSuffix,
  summarizeRefChecks,
  trimEdgeWords,
  refPrefix,
  type RefCheckTarget,
  type RefSearchOutcome,
} from "../../web/src/ref-check.ts";
import { traceDocRefs } from "../../web/src/policy-trace.ts";
import { db } from "../src/db.ts";
import {
  listRefChecks,
  MAX_REF_CHECKS,
  runRefChecks,
  toTargets,
  type Searcher,
} from "../src/services/ref-checks.ts";
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

const TARGET: RefCheckTarget = {
  key: refKey("docref", "财税〔2015〕119号"),
  kind: "docref",
  text: "财税〔2015〕119号",
  context: "根据财税〔2015〕119号第六条规定，企业研发费用加计扣除比例",
};

// 1) 主键与检索词
expect("主键按归一化文本生成", refKey("docref", "财税〔2015〕 119 号"), "docref:财税[2015]119号");
expect("不同写法主键一致", refKey("docref", "财税[2015]119号"), refKey("docref", "财税〔2015〕119号"));
expect("kind 进入主键", refKey("citation", "研发_百度百科"), "citation:研发_百度百科");
expect("去虚词：前导", trimEdgeWords("根据财税"), "财税");
expect("去虚词：收尾", trimEdgeWords("第六条规定"), "第六条");
expect("去虚词：两端", trimEdgeWords("号与国税发处理"), "国税发处理");
expect("全是虚词时返回空", trimEdgeWords("根据"), "");
expect("发文机关前缀", refPrefix("根据财税〔2015〕119号第六条", "〔2015〕119号"), "财税");
expect("公告类前缀原样保留", refPrefix("国家税务总局公告2017年第40号", "2017年第40号"), "国家税务总局公告");
expect("上下文没有文号时无前缀", refPrefix("土地增值税清算", "〔2006〕187号"), "");
expect("上下文取去虚词后最长中文段", contextKeywords(TARGET.context!, TARGET.text), "企业研发费用加计扣除比例");
expect("关键词排除已用作前缀的部分", contextKeywords("依据国税发〔2006〕187号与国税发处理", "〔2006〕187号", "国税发"), "");
expect("上下文过短返回空", contextKeywords("见文号", "文号"), "");
expect("空上下文返回空", contextKeywords("", "文号"), "");
expect("上下文关键词长度受限", contextKeywords("依据国家税务总局关于研发费用加计扣除政策执行指引的规定", "文号", "", 8).length, 8);
expect("检索词含文号与关键词", buildRefQuery(TARGET), "财税〔2015〕119号 企业研发费用加计扣除比例");
expect(
  "检索词补上发文机关",
  buildRefQuery({ key: "docref:[2006]187号", kind: "docref", text: "〔2006〕187号", context: "依据国税发〔2006〕187号第六条" }),
  "国税发〔2006〕187号",
);
expect("无上下文时只用文号", buildRefQuery({ ...TARGET, context: "" }), "财税〔2015〕119号");
expect("去掉百科后缀", stripSiteSuffix("研发_百度百科"), "研发");
expect("去掉知乎后缀", stripSiteSuffix("研发，原来是这么回事儿 - 知乎"), "研发，原来是这么回事儿");
expect("全是后缀时保留原标题", stripSiteSuffix("_百度百科"), "_百度百科");
expect("引用类检索词用清理后的标题", buildRefQuery({ key: "citation:研发_百度百科", kind: "citation", text: "研发_百度百科" }), "研发");
expect(
  "检索词候选：补发文机关并给出紧凑写法",
  refQueryVariants({ key: "docref:x", kind: "docref", text: "〔2009〕91 号", context: "按国税发〔2009〕91 号规定" }),
  ["国税发〔2009〕91 号", "国税发〔2009〕91号"],
);
expect(
  "检索词候选：两种写法相同时只留一条",
  refQueryVariants({ key: "docref:x", kind: "docref", text: "财税〔2015〕119号", context: "" }),
  ["财税〔2015〕119号"],
);
expect(
  "检索词候选：引用类只有一条",
  refQueryVariants({ key: "citation:x", kind: "citation", text: "研发_百度百科" }),
  ["研发"],
);

// 2) 四级判定
const hit = (title: string, url: string, snippet = "", relevance = 8): WebSearchResult => ({
  title,
  url,
  snippet,
  engine: "bing",
  relevance,
});
const OFFICIAL = hit(
  "财政部 国家税务总局 科技部关于完善研究开发费用税前加计扣除政策的通知 财税〔2015〕119号",
  "https://www.most.gov.cn/xxgk/a.pdf",
  "研发费用加计扣除",
);
const attempt = (status: SearchAttempt["status"], note: string): SearchAttempt => ({
  engine: "bing",
  via: "RSS",
  status,
  fetched: 10,
  kept: 0,
  dropped: 10,
  httpStatus: 200,
  note,
});
const outcome = (hits: WebSearchResult[], failed = false, note = "Bing 可用（RSS 保留 1 条）"): RefSearchOutcome => ({
  hits: hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet, relevance: h.relevance })),
  note,
  failed,
});

const matched = gradeRefCheck(TARGET, outcome([OFFICIAL]));
expect("标题含文号 → 找到公开出处", matched.verdict, "matched");
expect("证据地址", matched.evidence?.url, "https://www.most.gov.cn/xxgk/a.pdf");
expect("证据分级为官方原文", matched.evidence?.grade, "official");
expect("摘要里含文号也算命中", gradeRefCheck(TARGET, outcome([hit("政策通知", "https://a.gov.cn/x/y.html", "财税[2015]119号 全文")])).verdict, "matched");
expect("写法不同也能命中（归一化）", gradeRefCheck(TARGET, outcome([hit("财税[2015] 119 号 全文", "https://a.gov.cn/x/y.html")])).verdict, "matched");

const candidate = gradeRefCheck(TARGET, outcome([hit("研发费用加计扣除政策执行指引", "https://shanghai.chinatax.gov.cn/zcfw/a.html", "加计扣除比例")]));
expect("相关但没出现文号 → 候选待确认", candidate.verdict, "candidate");
expect("候选仍给出证据链接", candidate.evidence?.url, "https://shanghai.chinatax.gov.cn/zcfw/a.html");
ok("候选说明含文号", (candidate.note ?? "").includes("财税〔2015〕119号"), candidate.note);

expect("无可用结果 → 未检索到", gradeRefCheck(TARGET, outcome([])).verdict, "empty");
expect("未检索到沿用引擎说明", gradeRefCheck(TARGET, outcome([], false, "Bing 结果与检索词无关；百度 触发安全验证")).note, "Bing 结果与检索词无关；百度 触发安全验证");
expect("引擎全失败 → 检索失败", gradeRefCheck(TARGET, outcome([], true, "Bing 请求失败（HTTP 502）")).verdict, "error");
expect(
  "引用类优先选官方原文页",
  gradeRefCheck({ ...TARGET, kind: "citation" }, outcome([hit("百科", "https://baike.baidu.com/item/a/b", "", 9), OFFICIAL]))
    .evidence?.url,
  "https://www.most.gov.cn/xxgk/a.pdf",
);
expect("引用类找到官方页 → matched", gradeRefCheck({ ...TARGET, kind: "citation" }, outcome([OFFICIAL])).verdict, "matched");
expect("四级文案齐全", Object.keys(REF_VERDICT_TEXT).length, 4);
expect("四级提示齐全", Object.values(REF_VERDICT_HINT).every((s) => s.length > 0), true);

// 3) 复查对象与汇总
const trace = traceDocRefs("依据财税〔2015〕119号与国税发〔2006〕187号处理", [{ docNumber: "财税[2015]119号" }], ["web_search"]);
const targets = refCheckTargets(trace);
expect("无法核验的文号进入复查清单", targets.length, 1);
expect("复查对象主键", targets[0]?.key, "docref:[2006]187号");
expect("复查对象带上下文", (targets[0]?.context ?? "").includes("187号"), true);
expect(
  "待确认与无法核验都进清单",
  refCheckTargets(traceDocRefs("依据财税〔2015〕119号与国税发〔2006〕187号处理", [{ docNumber: "财税[2015]119号" }], [])).length,
  1,
);
expect("有出处的文号不进清单", refCheckTargets(traceDocRefs("财税[2015]119号", [{ docNumber: "财税[2015]119号" }], [])).length, 0);
const sum = summarizeRefChecks([
  { verdict: "matched", checkedAt: "2026-09-29T01:00:00.000Z" },
  { verdict: "candidate", checkedAt: "2026-09-29T02:00:00.000Z" },
  { verdict: "empty", checkedAt: null },
  { verdict: "error" },
]);
expect("汇总计数", [sum.total, sum.matched, sum.candidate, sum.empty, sum.error], [4, 1, 1, 1, 1]);
expect("汇总取最近复查时间", sum.checkedAt, "2026-09-29T02:00:00.000Z");
expect("空汇总时间为 null", summarizeRefChecks([]).checkedAt, null);
expect("复查后待处理数扣掉已找到出处的", pendingAfterRecheck(5, sum), 4);
expect("待处理数不会为负", pendingAfterRecheck(1, { ...sum, matched: 3 }), 0);

// 4) 服务端：请求体规范化
expect("缺 text 的条目被丢弃", toTargets([{ kind: "docref" }, { text: "  " }]).length, 0);
expect("主键由服务端计算", toTargets([{ text: "财税〔2015〕119号", key: "客户端伪造" }])[0]?.key, "docref:财税[2015]119号");
expect("同一文号只查一次", toTargets([{ text: "财税〔2015〕119号" }, { text: "财税[2015] 119号" }]).length, 1);
expect("超过上限截断", toTargets(Array.from({ length: 14 }, (_, i) => ({ text: `国税发〔200${i}〕1号` }))).length, MAX_REF_CHECKS);
expect("未知 kind 归为 docref", toTargets([{ text: "x〔2015〕1号", kind: "别的" }])[0]?.kind, "docref");
expect("非数组安全返回空", toTargets(null).length, 0);
expect("保留上下文", toTargets([{ text: "财税〔2015〕119号", context: "研发费用" }])[0]?.context, "研发费用");

// 5) 服务端：假检索器跑通全链路并落库
const TASK = "__verify_refcheck__";
db.prepare(`DELETE FROM ref_checks WHERE task_id = ?`).run(TASK);
const fake: Searcher = async (query) => {
  const results = query.includes("187号") ? [] : [OFFICIAL];
  const attempts = [attempt(results.length > 0 ? "ok" : "irrelevant", results.length > 0 ? "保留 1 条" : "10 条结果与检索词无关")];
  return { results, attempts, minScore: 2 } satisfies DetailedSearch;
};
const ran = await runRefChecks(
  TASK,
  [
    { key: refKey("docref", "财税〔2015〕119号"), kind: "docref", text: "财税〔2015〕119号", context: "研发费用加计扣除" },
    { key: refKey("docref", "国税发〔2006〕187号"), kind: "docref", text: "国税发〔2006〕187号", context: "土地增值税清算" },
  ],
  fake,
);
expect("两条都跑完", ran.length, 2);
expect("第一条判定为找到出处", ran[0]?.verdict, "matched");
expect("第二条判定为未检索到", ran[1]?.verdict, "empty");
expect("记录检索词", ran[0]?.query, "财税〔2015〕119号 研发费用加计扣除");
expect("记录引擎尝试过程", ran[0]?.attempts.length, 1);

const stored = listRefChecks(TASK);
expect("落库往返条数", stored.length, 2);
expect("落库往返判定", stored.map((c) => c.verdict).sort(), ["empty", "matched"]);
expect("落库往返证据地址", stored.find((c) => c.verdict === "matched")?.evidence?.url, "https://www.most.gov.cn/xxgk/a.pdf");
expect("落库往返证据分级", stored.find((c) => c.verdict === "matched")?.evidence?.grade, "official");
expect("读取时重算分级理由", (stored.find((c) => c.verdict === "matched")?.evidence?.gradeReason ?? "").length > 0, true);
expect("落库往返检索词", stored.find((c) => c.text.includes("187"))?.query, "国税发〔2006〕187号 土地增值税清算");
expect("未检索到时无证据", stored.find((c) => c.verdict === "empty")?.evidence, null);
expect(
  "空手而归时说明另试过检索词",
  (stored.find((c) => c.verdict === "empty")?.note ?? "").includes("另试 1 种检索词"),
  true,
);
expect(
  "两种检索词的引擎尝试都留痕",
  stored.find((c) => c.verdict === "empty")?.attempts.length,
  2,
);
expect(
  "全都没查到时记录最初那条最具体的检索词",
  stored.find((c) => c.verdict === "empty")?.query,
  "国税发〔2006〕187号 土地增值税清算",
);
expect("复查时间一致（同批）", new Set(stored.map((c) => c.checkedAt)).size, 1);

const again = await runRefChecks(TASK, [{ key: refKey("docref", "国税发〔2006〕187号"), kind: "docref", text: "国税发〔2006〕187号", context: "土地增值税清算建筑安装工程费" }], async () => ({
  results: [hit("国家税务总局关于土地增值税清算有关问题的通知 国税发〔2006〕187号", "https://fgk.chinatax.gov.cn/zcfgk/a.html")],
  attempts: [attempt("ok", "保留 1 条")],
  minScore: 2,
}));
expect("复查覆盖为最新一次", again[0]?.verdict, "matched");
expect("同一文号不新增记录", listRefChecks(TASK).length, 2);
expect(
  "覆盖后检索词更新",
  listRefChecks(TASK).find((c) => c.text.includes("187"))?.query,
  "国税发〔2006〕187号 土地增值税清算建筑安装工程费",
);

const boom = await runRefChecks(TASK, [{ key: refKey("docref", "财税〔2016〕1号"), kind: "docref", text: "财税〔2016〕1号" }], async () => {
  throw new Error("网络不可达");
});
expect("检索异常记为失败而不是崩掉", boom[0]?.verdict, "error");
expect("失败原因入库", boom[0]?.note, "网络不可达");
expect("失败记录也可读回", listRefChecks(TASK).find((c) => c.text.includes("2016"))?.verdict, "error");
db.prepare(`DELETE FROM ref_checks WHERE task_id = ?`).run(TASK);
expect("清理验证数据", listRefChecks(TASK).length, 0);

// 6) 真实任务走查：已落库的复查记录必须自洽，待复查文号数量如实统计
let tasksPending = 0;
let pendingTotal = 0;
let storedTotal = 0;
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
  const tr = traceDocRefs(text, parsed, rows.map((r) => r.tool_name));
  const pending = refCheckTargets(tr);
  pendingTotal += pending.length;
  if (pending.length > 0) tasksPending += 1;
  const recs = listRefChecks(t.id);
  storedTotal += recs.length;
  for (const rec of recs) {
    checks += 1;
    if (rec.key !== refKey(rec.kind, rec.text)) failures.push(`${t.id.slice(0, 8)} 复查记录主键与文本不符：${rec.key}`);
    if (!["matched", "candidate", "empty", "error"].includes(rec.verdict)) failures.push(`${t.id.slice(0, 8)} 复查判定取值非法：${rec.verdict}`);
    if (rec.verdict === "matched" && rec.evidence === null) failures.push(`${t.id.slice(0, 8)} 判定为找到出处却没有证据`);
    if (rec.evidence && !/^https?:\/\//.test(rec.evidence.url)) failures.push(`${t.id.slice(0, 8)} 证据地址不是 http(s)`);
  }
}
console.log(`[verify] 真实任务走查：${tasksPending} 个任务共 ${pendingTotal} 处文号待复查 · 已落库复查记录 ${storedTotal} 条`);

console.log(`[verify] 文号复查检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 政策文号复查规则不符");
  process.exit(1);
}
console.log("[PASS] 政策文号复查正确（检索词构造 / 四级判定 / 落库往返与覆盖 / 真实任务走查）");
