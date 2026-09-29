/**
 * 验证脚本：政策文号联网复查（检索词构造 / 四级判定 / 落库往返 / 真实任务走查）。
 * 检索通过注入的假实现离线跑通，不依赖网络。
 * 运行：pnpm verify:refcheck
 */
import {
  matchPolicyDocNum,
  normalizeDocNum,
  parsePolicyLibrary,
  type DetailedSearch,
  type PolicyLibraryHit,
  type SearchAttempt,
  type WebSearchResult,
} from "@tax/business-tools";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRefQuery,
  buildRevisionInstruction,
  citationTargets,
  contextKeywords,
  gradeRefCheck,
  refCheckTargets,
  refKey,
  REF_VERDICT_HINT,
  REF_VERDICT_TEXT,
  refQueryVariants,
  revisionCounts,
  stripSiteSuffix,
  summarizeRefChecks,
  toRevisionItems,
  trimEdgeWords,
  refPrefix,
  type RefCheckTarget,
  type RefSearchOutcome,
} from "../../web/src/ref-check.ts";
import { traceDocRefs } from "../../web/src/policy-trace.ts";
import { extractCitations } from "../../web/src/search-evidence.ts";
import { gradeCitation } from "../../web/src/citation-grade.ts";
import { topicHint } from "../../web/src/domain-keywords.ts";
import {
  matchedStillValid,
  domainOverlap,
  evidenceCanReplace,
  isDomainToken,
  keptBetterNote,
  onTaskTopic,
  preservedNote,
  reusableDocNum,
  shouldOverwrite,
  topicOverlap,
  topicTokens,
  unresolvedTargets,
} from "../../web/src/ref-check.ts";
import { db } from "../src/db.ts";
import {
  isRevisionBlocked,
  REVISION_ALLOWED_TOOLS,
  REVISION_BLOCKED_TOOLS,
  revisionAllowedTools,
  revisionBlockedNames,
} from "../../web/src/revision-mode.ts";
import {
  BATCH_REF_BUDGET,
  BATCH_REF_MAX,
  listRefChecks,
  MAX_REF_CHECKS,
  pendingCitationTargets,
  pendingRefTargets,
  planBatchRefChecks,
  policyDocNumQuery,
  runRefChecks,
  saveRefCheck,
  toTargets,
  upgradeRefTargets,
  verifiedOfficialDocs,
  type PolicySearcher,
  type Searcher,
  type VerifiedOfficialDoc,
} from "../src/services/ref-checks.ts";
import { getTask, listTasks } from "../src/services/task-store.ts";

const failures: string[] = [];
const here = path.dirname(fileURLToPath(import.meta.url));
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
// 以下四条来自实测复查不到出处的真实结论写法
expect(
  "联合发文机关连着取",
  refPrefix("财政部 税务总局 科技部公告2022年第28号同时废止", "2022年第28号"),
  "财政部 税务总局 科技部公告",
);
expect(
  "四部委公告同样连着取",
  refPrefix("财政部 税务总局 国家发展改革委 工业和信息化部公告2023年第44号", "2023年第44号"),
  "财政部 税务总局 国家发展改革委 工业和信息化部公告",
);
expect(
  "前导副词不进前缀",
  refPrefix("《归集表》已按国家税务总局公告2019年第41号", "2019年第41号"),
  "国家税务总局公告",
);
expect(
  "普通词组不当作机关往左延伸",
  refPrefix("同时废止 财政部 税务总局公告2022年第16号", "2022年第16号"),
  "财政部 税务总局公告",
);
expect(
  "顿号分隔的联合发文归一成空格",
  refPrefix("财政部、税务总局公告2023年第8号", "2023年第8号"),
  "财政部 税务总局公告",
);
expect(
  "非公告类文号不往左延伸",
  refPrefix("财政部 税务总局 财税〔2015〕119号", "〔2015〕119号"),
  "财税",
);
expect(
  "动词短语「确认为」不进前缀（实测 Agent 自己写的核对结论就是这种句式）",
  refPrefix("打开成功，确认为国税函〔2010〕220号原文", "〔2010〕220号"),
  "国税函",
);
expect("上下文取去虚词后最长中文段", contextKeywords(TARGET.context!, TARGET.text), "企业研发费用加计扣除比例");
expect("关键词排除已用作前缀的部分", contextKeywords("依据国税发〔2006〕187号与国税发处理", "〔2006〕187号", "国税发"), "");
expect("上下文过短返回空", contextKeywords("见文号", "文号"), "");
expect("空上下文返回空", contextKeywords("", "文号"), "");
expect("上下文关键词长度受限", contextKeywords("依据国家税务总局关于研发费用加计扣除政策执行指引的规定", "文号", "", 8).length, 8);
expect("检索词含文号与关键词", buildRefQuery(TARGET), "财税〔2015〕119号 企业研发费用加计扣除比例");
expect(
  "无发文机关时用主题词兜底",
  buildRefQuery({
    key: "docref:[2022]28号",
    kind: "docref",
    text: "2022年第28号",
    context: "同时废止 2021年第13号、2022年第16号、2022年第28号 | https://fgk.chinatax.gov.cn",
    hint: "加计扣除 研发费用",
  }),
  "2022年第28号 加计扣除 研发费用",
);
expect(
  "有发文机关时仍用上下文关键词、不掺主题词",
  buildRefQuery({
    key: "docref:[2015]119号",
    kind: "docref",
    text: "财税〔2015〕119号",
    context: "根据财税〔2015〕119号提高加计扣除比例",
    hint: "底稿 加计扣除",
  }),
  "财税〔2015〕119号 提高加计扣除比例",
);
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
expect(
  "引用类找到官方页 → matched",
  gradeRefCheck({ ...TARGET, kind: "citation", hint: "研发费用 加计扣除" }, outcome([OFFICIAL])).verdict,
  "matched",
);
expect("四级文案齐全", Object.keys(REF_VERDICT_TEXT).length, 4);
expect("四级提示齐全", Object.values(REF_VERDICT_HINT).every((s) => s.length > 0), true);

// 2b) 弱证据引用找官方原文
const WEAK_URL = "https://baike.baidu.com/item/%E7%A0%94%E5%8F%91/4815440";
const weakTargets = citationTargets(
  [
    { title: "研发_百度百科", url: WEAK_URL, grade: "weak" },
    { title: "研发费用加计扣除政策执行指引", url: "https://fgk.chinatax.gov.cn/zcfgk/a.html", grade: "official" },
    { title: "研发实务", url: "https://zhuanlan.zhihu.com/p/1", grade: "professional" },
  ],
  "研发费用 加计扣除",
  10,
);
expect("只挑弱证据引用", weakTargets.length, 1);
expect("引用复查主键用地址", weakTargets[0]?.key, refKey("citation", WEAK_URL));
expect("带上任务级领域补充词", weakTargets[0]?.hint, "研发费用 加计扣除");
expect("排除引用自身", weakTargets[0]?.excludeUrl, WEAK_URL);
expect("引用检索词 = 清理后的标题 + 领域词", buildRefQuery(weakTargets[0]!), "研发 研发费用 加计扣除");
expect(
  "引用检索词候选：先带领域词再退回标题",
  refQueryVariants(weakTargets[0]!),
  ["研发 研发费用 加计扣除", "研发"],
);
expect("无领域词时只用标题", buildRefQuery({ ...weakTargets[0]!, hint: "" }), "研发");
expect(
  "弱证据过多时按上限截断",
  citationTargets(
    Array.from({ length: 14 }, (_, i) => ({ title: `词条${i}`, url: `https://baike.baidu.com/item/x/${i}`, grade: "weak" })),
    "",
    10,
  ).length,
  10,
);
const cit = weakTargets[0]!;
expect(
  "找到官方文件页 → matched",
  gradeRefCheck(cit, outcome([hit("研发费用加计扣除政策执行指引", "https://fgk.chinatax.gov.cn/zcfgk/a.html")])).verdict,
  "matched",
);
expect("排除自身后只剩原页面 → 未找到", gradeRefCheck(cit, outcome([hit("研发_百度百科", WEAK_URL)])).verdict, "empty");
expect(
  "只剩同类百科不算候选",
  gradeRefCheck(cit, outcome([hit("研发 - MBA智库百科", "https://wiki.mbalib.com/wiki/x")])).verdict,
  "empty",
);
expect(
  "专业文章作为候选",
  gradeRefCheck(cit, outcome([hit("研发费用加计扣除实务", "https://www.shui5.cn/article/a/b.html")])).verdict,
  "candidate",
);
expect(
  "matched 说明含替换动作",
  gradeRefCheck(cit, outcome([hit("x", "https://fgk.chinatax.gov.cn/zcfgk/a.html")])).note.includes("替换"),
  true,
);

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

// 3b) 修订指令：把复查结果整理成可提交给 Agent 的续跑指令（人工核对后才提交）
const revItems = toRevisionItems([
  {
    kind: "docref",
    verdict: "matched",
    text: "财税〔2015〕119号",
    evidence: { title: "政策执行指引", url: "https://a.gov.cn/x.pdf" },
    checkedAt: "2026-09-29T02:00:00.000Z",
  },
  {
    kind: "citation",
    verdict: "matched",
    text: "研发_百度百科",
    subjectUrl: WEAK_URL,
    evidence: { title: "政策执行指引", url: "https://a.gov.cn/x.pdf" },
    checkedAt: "2026-09-29T02:00:00.000Z",
  },
  {
    kind: "docref",
    verdict: "empty",
    text: "国税发〔2006〕187号",
    evidence: null,
    checkedAt: "2026-09-29T02:00:00.000Z",
  },
  {
    kind: "docref",
    verdict: "error",
    text: "财税〔2016〕1号",
    evidence: null,
    checkedAt: "2026-09-29T02:00:00.000Z",
  },
]);
expect("检索失败不进修订素材", revItems.length, 3);
expect(
  "文号类排在引用类之前",
  revItems.map((i) => i.kind),
  ["docref", "docref", "citation"],
);
expect("修订素材计数", revisionCounts(revItems), { total: 3, replace: 2, unresolved: 1 });
expect("空素材返回空指令", buildRevisionInstruction([]), "");
const instr = buildRevisionInstruction(revItems);
ok("指令限定只改依据与引用", instr.includes("不要改动金额、测算过程、差异认定与结论意见"), instr.slice(0, 80));
ok(
  "指令禁止重跑业务工具（写回不能把底稿与比对记录换掉）",
  instr.includes("不要重新调用解析、底稿生成、模板填列或底稿比对一类业务工具"),
);
ok("指令说明重跑会替换上一轮交付证据", instr.includes("已有工具结果与比对记录是上一轮的交付证据"));

// 修订模式的工具黑名单：指令里嘱咐不算数，本轮会话里直接没有这些工具才算数
expect("黑名单含底稿生成", isRevisionBlocked("generate_workpaper"), true);
expect("黑名单含底稿比对", isRevisionBlocked("compare_workpapers"), true);
expect("黑名单含模板填列", isRevisionBlocked("fill_land_vat_workpaper"), true);
expect("黑名单含资料解析", isRevisionBlocked("parse_uploaded_files"), true);
expect(
  "黑名单含测算与核查",
  isRevisionBlocked("calculate_rd_adjustment") && isRevisionBlocked("check_rd_expenses"),
  true,
);
expect("检索工具不在黑名单（补出处要能联网核对）", isRevisionBlocked("web_search"), false);
expect("读取原文工具不在黑名单", isRevisionBlocked("fetch_public_document"), false);
expect("政策检索工具不在黑名单", isRevisionBlocked("search_rd_policy"), false);
expect("白名单里的工具都不在黑名单", REVISION_ALLOWED_TOOLS.every((t) => !isRevisionBlocked(t)), true);
expect("黑名单没有重复项", new Set(REVISION_BLOCKED_TOOLS).size, REVISION_BLOCKED_TOOLS.length);
const toolset = [
  { name: "generate_workpaper" },
  { name: "compare_workpapers" },
  { name: "web_search" },
  { name: "fetch_public_document" },
];
expect(
  "过滤后只剩检索与读取类工具",
  revisionAllowedTools(toolset).map((t) => t.name),
  ["web_search", "fetch_public_document"],
);
expect("被摘掉的工具名可用于留痕", revisionBlockedNames(toolset), ["generate_workpaper", "compare_workpapers"]);
expect("过滤不改动原数组", toolset.length, 4);
const runnerSrc = fs.readFileSync(path.resolve(here, "../src/services/agent-runner.ts"), "utf8");
ok("运行时在修订模式下过滤任务工具", runnerSrc.includes("revisionAllowedTools(allTaskTools)"));
ok("运行时在修订模式下过滤智能体自带工具", runnerSrc.includes("tools: revisionAllowedTools(agent0.tools)"));
ok("修订模式在 run_started 事件里写明", runnerSrc.includes("修订模式：只改依据与引用"));
const routesSrc = fs.readFileSync(path.resolve(here, "../src/routes/tasks.ts"), "utf8");
ok(
  "续跑接口接受 revisionOnly 并透传给运行时",
  routesSrc.includes("const revisionOnly = body.revisionOnly === true") &&
    routesSrc.includes("{ resume: true, revisionOnly }"),
);
const writebackSrc = fs.readFileSync(path.join(here, "writeback-evidence.ts"), "utf8");
ok("写回脚本默认走修订模式", writebackSrc.includes("revisionOnly: true"));
ok("指令含补文号出处段", instr.includes("【补文号出处】") && instr.includes("财税〔2015〕119号 → 《政策执行指引》 https://a.gov.cn/x.pdf"));
ok("指令含替换弱证据段与原地址", instr.includes("【替换弱证据引用】") && instr.includes(WEAK_URL));
ok("指令含未取得原文段", instr.includes("【标注未取得原文】") && instr.includes("国税发〔2006〕187号"));
ok("指令附检索时间", instr.includes("2026-09-29 02:00"));
ok("指令要求重新输出完整结论", instr.includes("重新输出完整结论"));
ok("指令禁止新增未核验口径", instr.includes("不得新增未经工具计算或联网核验"));
expect(
  "只有未解决项时不出现替换段",
  buildRevisionInstruction(revItems.filter((i) => i.verdict === "empty")).includes("【替换弱证据引用】"),
  false,
);
expect(
  "只有替换项时不出现未取得原文段",
  buildRevisionInstruction(revItems.filter((i) => i.verdict === "matched")).includes("【标注未取得原文】"),
  false,
);
expect(
  "候选页写进未取得原文段并标注需人工确认",
  buildRevisionInstruction([
    {
      kind: "docref",
      verdict: "candidate",
      text: "国税发〔2006〕187号",
      evidence: { title: "候选页", url: "https://b.cn/y" },
      checkedAt: "2026-09-29T02:00:00.000Z",
    },
  ]).includes("需人工确认"),
  true,
);

// 4) 服务端：请求体规范化
expect("缺 text 的条目被丢弃", toTargets([{ kind: "docref" }, { text: "  " }]).length, 0);
expect("主键由服务端计算", toTargets([{ text: "财税〔2015〕119号", key: "客户端伪造" }])[0]?.key, "docref:财税[2015]119号");
expect("同一文号只查一次", toTargets([{ text: "财税〔2015〕119号" }, { text: "财税[2015] 119号" }]).length, 1);
expect("超过上限截断", toTargets(Array.from({ length: 14 }, (_, i) => ({ text: `国税发〔200${i}〕1号` }))).length, MAX_REF_CHECKS);
expect("未知 kind 归为 docref", toTargets([{ text: "x〔2015〕1号", kind: "别的" }])[0]?.kind, "docref");
expect("非数组安全返回空", toTargets(null).length, 0);
expect("保留上下文", toTargets([{ text: "财税〔2015〕119号", context: "研发费用" }])[0]?.context, "研发费用");
expect(
  "引用条目用地址做主键",
  toTargets([{ kind: "citation", text: "研发_百度百科", url: WEAK_URL }], "研发费用")[0]?.key,
  refKey("citation", WEAK_URL),
);
expect(
  "引用条目带上任务级补充词",
  toTargets([{ kind: "citation", text: "研发_百度百科", url: WEAK_URL }], "研发费用")[0]?.hint,
  "研发费用",
);
expect(
  "条目自带补充词优先于任务级",
  toTargets([{ kind: "citation", text: "x", url: WEAK_URL, hint: "自定义" }], "研发费用")[0]?.hint,
  "自定义",
);
expect("引用条目记录排除地址", toTargets([{ kind: "citation", text: "x", url: WEAK_URL }])[0]?.excludeUrl, WEAK_URL);
expect("非 http 地址不作为排除项", toTargets([{ kind: "citation", text: "x", url: "ftp://a" }])[0]?.excludeUrl, undefined);
expect("文号条目不带补充词", toTargets([{ text: "财税〔2015〕119号" }], "研发费用")[0]?.hint, undefined);
expect(
  "同一地址只查一次",
  toTargets([
    { kind: "citation", text: "标题A", url: WEAK_URL },
    { kind: "citation", text: "标题B", url: WEAK_URL },
  ]).length,
  1,
);

// 4b) 批量复查计划：预算切分、跳过无待办的任务、硬上限
const mkTargets = (n: number, salt: string): RefCheckTarget[] =>
  Array.from({ length: n }, (_, i) => ({
    key: refKey("docref", `〔200${i}〕${salt}${i}号`),
    kind: "docref" as const,
    text: `〔200${i}〕${salt}${i}号`,
  }));
const pendingMap: Record<string, RefCheckTarget[]> = { a: mkTargets(3, "a"), b: [], c: mkTargets(2, "c") };
const batchCandidates = [
  { id: "a", title: "任务A" },
  { id: "b", title: "任务B" },
  { id: "c", title: "任务C" },
];
const pendingOf = (id: string) => pendingMap[id] ?? [];
expect("跳过没有待办文号的任务", planBatchRefChecks(batchCandidates, pendingOf, 9).map((p) => p.id), ["a", "c"]);
expect("预算内按顺序切分", planBatchRefChecks(batchCandidates, pendingOf, 4).map((p) => p.targets.length), [3, 1]);
expect(
  "预算充足时全量安排",
  planBatchRefChecks(batchCandidates, pendingOf, 9).reduce((s, p) => s + p.targets.length, 0),
  5,
);
expect("预算为 0 时不安排任务", planBatchRefChecks(batchCandidates, pendingOf, 0).length, 0);
expect("负预算按 0 处理", planBatchRefChecks(batchCandidates, pendingOf, -3).length, 0);
expect("默认预算在上限之内", BATCH_REF_BUDGET > 0 && BATCH_REF_BUDGET <= BATCH_REF_MAX, true);
expect(
  "超过硬上限时按上限截断",
  planBatchRefChecks(batchCandidates, pendingOf, 9999).reduce((s, p) => s + p.targets.length, 0) <= BATCH_REF_MAX,
  true,
);
expect(
  "计划保留任务标题",
  planBatchRefChecks(batchCandidates, pendingOf, 9).map((p) => p.title),
  ["任务A", "任务C"],
);

// 5) 服务端：假检索器跑通全链路并落库
const TASK = "__verify_refcheck__";
db.prepare(`DELETE FROM ref_checks WHERE task_id = ?`).run(TASK);
/**
 * 离线段一律显式传这个桩：`runRefChecks` 第 4 个参数默认是真实的 searchPolicyLibrary。
 * 现有目标的上下文都取不到发文机关，`policyDocNumQuery` 返回空串、政策法规库这一路会被跳过，
 * 所以当前并不联网；但那是隐含前提——一旦有人给目标加上带机关的上下文，就会静默发起真实请求，
 * 让离线门禁变慢且结果随网络环境波动。用抛错的桩把前提变成显式约束。
 */
const offlineLib: PolicySearcher = async () => {
  throw new Error("离线验证不应访问政策法规库：请给这个目标显式注入假的 PolicySearcher");
};
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
  offlineLib,
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
}), offlineLib);
expect("复查覆盖为最新一次", again[0]?.verdict, "matched");
expect("同一文号不新增记录", listRefChecks(TASK).length, 2);
expect(
  "覆盖后检索词更新",
  listRefChecks(TASK).find((c) => c.text.includes("187"))?.query,
  "国税发〔2006〕187号 土地增值税清算建筑安装工程费",
);

const citRan = await runRefChecks(TASK, weakTargets.slice(0, 1), async () => ({
  results: [hit("研发费用加计扣除政策执行指引", "https://fgk.chinatax.gov.cn/zcfgk/a.html")],
  attempts: [attempt("ok", "保留 1 条")],
  minScore: 2,
}), offlineLib);
expect("引用复查记下替代来源", citRan[0]?.evidence?.url, "https://fgk.chinatax.gov.cn/zcfgk/a.html");
expect("引用复查保留被替换的原地址", citRan[0]?.subjectUrl, WEAK_URL);
expect(
  "引用复查落库后可读回原地址",
  listRefChecks(TASK).find((c) => c.kind === "citation")?.subjectUrl,
  WEAK_URL,
);
expect("文号复查的原地址为空串", listRefChecks(TASK).find((c) => c.kind === "docref")?.subjectUrl, "");
expect(
  "引用复查主键按原地址计算",
  listRefChecks(TASK).find((c) => c.kind === "citation")?.key,
  `citation:${WEAK_URL.replace(/\s+/g, "")}`,
);

const boom = await runRefChecks(TASK, [{ key: refKey("docref", "财税〔2016〕1号"), kind: "docref", text: "财税〔2016〕1号" }], async () => {
  throw new Error("网络不可达");
}, offlineLib);
expect("检索异常记为失败而不是崩掉", boom[0]?.verdict, "error");
expect("失败原因入库", boom[0]?.note, "网络不可达");
expect("失败记录也可读回", listRefChecks(TASK).find((c) => c.text.includes("2016"))?.verdict, "error");
db.prepare(`DELETE FROM ref_checks WHERE task_id = ?`).run(TASK);
expect("清理验证数据", listRefChecks(TASK).length, 0);

// 6) 真实任务走查：已落库的复查记录必须自洽，待复查文号数量如实统计
let tasksPending = 0;
let pendingTotal = 0;
let storedTotal = 0;
let citeTotal = 0;
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
  const recs = listRefChecks(t.id);
  // 已经找到公开出处的不再算「待复查」：与批量入口和看板口径保持一致。
  // 原引用标题必须一起传进去——引用替换的主题相关判据要用它重算，少传就与服务端口径岔开。
  const stillOfficial = (c: {
    kind?: "docref" | "citation";
    text: string;
    evidence: { url: string; title: string; snippet?: string } | null;
  }) => matchedStillValid(c.kind ?? "docref", c.evidence, gradeCitation, c.text, topicHint(text, 2));
  const pending = unresolvedTargets(refCheckTargets(tr), recs, stillOfficial);
  pendingTotal += pending.length;
  if (pending.length > 0) tasksPending += 1;
  // 服务端独立算出的待复查清单必须与前端口径一致（批量入口不依赖前端传清单）
  const fromService = pendingRefTargets(t.id);
  checks += 1;
  if (fromService.length !== pending.length) {
    failures.push(`${t.id.slice(0, 8)} 服务端待复查清单 ${fromService.length} 处 ≠ 前端口径 ${pending.length} 处`);
  }
  checks += 1;
  if (fromService.some((x, i) => x.key !== pending[i]?.key)) {
    failures.push(`${t.id.slice(0, 8)} 服务端待复查清单主键顺序与前端口径不一致`);
  }
  storedTotal += recs.length;
  // 弱证据引用清单：服务端批量入口算出的必须与结果页同一口径（含领域补充词）
  const parsedCalls = rows.map((r) => {
    let result: unknown = null;
    try {
      result = r.result ? JSON.parse(r.result) : null;
    } catch {
      result = null;
    }
    return { toolName: r.tool_name, result };
  });
  const wantCites = unresolvedTargets(
    citationTargets(
      extractCitations(parsedCalls).map((c) => ({ ...c, grade: gradeCitation(c.url, c.title).grade })),
      topicHint(text, 2),
      10,
    ),
    recs,
    stillOfficial,
  );
  const gotCites = pendingCitationTargets(t.id);
  checks += 1;
  if (gotCites.length !== wantCites.length) {
    failures.push(`${t.id.slice(0, 8)} 服务端弱证据清单 ${gotCites.length} 条 ≠ 前端口径 ${wantCites.length} 条`);
  }
  checks += 1;
  if (gotCites.some((c, i) => c.key !== wantCites[i]?.key || c.hint !== wantCites[i]?.hint)) {
    failures.push(`${t.id.slice(0, 8)} 服务端弱证据清单主键或补充词与前端口径不一致`);
  }
  citeTotal += gotCites.length;
  for (const c of gotCites) {
    checks += 1;
    if (
      c.kind !== "citation" ||
      c.key !== refKey("citation", c.excludeUrl ?? "") ||
      !/^https?:\/\//.test(c.excludeUrl ?? "")
    ) {
      failures.push(`${t.id.slice(0, 8)} 弱证据复查目标不自洽：${c.key}`);
    }
  }
  for (const rec of recs) {
    checks += 1;
    // 文号按文本算主键，引用按原地址算主键：两种都必须能从落库字段自校验回来
    const wantKey = refKey(rec.kind, rec.kind === "citation" ? rec.subjectUrl : rec.text);
    if (rec.key !== wantKey) failures.push(`${t.id.slice(0, 8)} 复查记录主键不符：${rec.key} ≠ ${wantKey}`);
    if (rec.kind === "citation" && !/^https?:\/\//.test(rec.subjectUrl)) {
      failures.push(`${t.id.slice(0, 8)} 引用类复查记录缺少原地址：${rec.key}`);
    }
    if (!["matched", "candidate", "empty", "error"].includes(rec.verdict)) failures.push(`${t.id.slice(0, 8)} 复查判定取值非法：${rec.verdict}`);
    if (rec.verdict === "matched" && rec.evidence === null) failures.push(`${t.id.slice(0, 8)} 判定为找到出处却没有证据`);
    if (rec.evidence && !/^https?:\/\//.test(rec.evidence.url)) failures.push(`${t.id.slice(0, 8)} 证据地址不是 http(s)`);
  }
}
console.log(
  `[verify] 真实任务走查：${tasksPending} 个任务共 ${pendingTotal} 处文号待复查 · 弱证据引用待替换 ${citeTotal} 条 · 已落库复查记录 ${storedTotal} 条`,
);

// 8) 复查失败不能把已经找到的公开出处覆盖掉（实测踩过：点一次批量复查，看板上的证据反而变少）
// 自成一回合：先清掉假任务的记录，不受前面小节留下的状态影响
db.prepare(`DELETE FROM ref_checks WHERE task_id = ?`).run(TASK);
const hitSearcher: Searcher = async () =>
  ({ results: [OFFICIAL], attempts: [attempt("ok", "保留 1 条")], minScore: 2 }) satisfies DetailedSearch;
const missSearcher: Searcher = async () =>
  ({ results: [], attempts: [attempt("irrelevant", "10 条结果与检索词无关")], minScore: 2 }) satisfies DetailedSearch;
const firstRun = await runRefChecks(TASK, [TARGET], hitSearcher, offlineLib);
expect("第一次检索找到出处", firstRun[0]?.verdict, "matched");
const beforeRec = listRefChecks(TASK)[0];
expect("前置：库里已记为找到出处", beforeRec?.verdict, "matched");
const rerun = await runRefChecks(TASK, [TARGET], missSearcher, offlineLib);
expect("这次检索本身判为未命中", rerun[0]?.verdict, "empty");
const kept = listRefChecks(TASK).find((c) => c.text.includes("119"));
expect("库里仍是已找到出处", kept?.verdict, "matched");
expect("证据地址没被抹掉", kept?.evidence?.url, beforeRec?.evidence?.url);
expect("证据分级没被抹掉", kept?.evidence?.grade, beforeRec?.evidence?.grade);
ok("note 记下保留原因", (kept?.note ?? "").includes("保留此前已找到的公开出处"), kept?.note ?? "");
ok("note 记下这次的判定", (kept?.note ?? "").includes("再次检索为"), kept?.note ?? "");
expect("重试过程追加进 attempts", (kept?.attempts.length ?? 0) > (beforeRec?.attempts.length ?? 0), true);
expect("复查时间更新到最新", (kept?.checkedAt ?? "") >= (beforeRec?.checkedAt ?? ""), true);
expect("没有新增记录（仍是同一 key 覆盖）", listRefChecks(TASK).length, 1);
db.prepare(`DELETE FROM ref_checks WHERE task_id = ?`).run(TASK);
await runRefChecks(TASK, [TARGET], missSearcher, offlineLib);
expect("先记为未命中", listRefChecks(TASK)[0]?.verdict, "empty");
const upgraded = await runRefChecks(TASK, [TARGET], hitSearcher, offlineLib);
expect("反向：找到出处要能顶掉未命中", upgraded[0]?.verdict, "matched");
expect("库里升级为已找到出处", listRefChecks(TASK)[0]?.verdict, "matched");
expect("升级后仍是一条记录", listRefChecks(TASK).length, 1);

// 8.1 纯函数层
expect("没有旧结果时可以写入", shouldOverwrite(null, "empty"), true);
expect("matched 不被 empty 顶掉", shouldOverwrite("matched", "empty"), false);
expect("matched 不被 error 顶掉", shouldOverwrite("matched", "error"), false);
expect("matched 不被 candidate 顶掉", shouldOverwrite("matched", "candidate"), false);
expect("matched 可以被新的 matched 顶掉", shouldOverwrite("matched", "matched"), true);
expect("empty 可以被 matched 顶掉", shouldOverwrite("empty", "matched"), true);
expect("candidate 可以被 matched 顶掉", shouldOverwrite("candidate", "matched"), true);
expect(
  "批量目标筛掉已找到出处的",
  unresolvedTargets(
    [
      { key: "a", text: "甲" },
      { key: "b", text: "乙" },
    ],
    [{ key: "a", verdict: "matched" }],
  ).map((t) => t.key),
  ["b"],
);
expect(
  "candidate 与 empty 都仍算未解决",
  unresolvedTargets([{ key: "a" }, { key: "b" }, { key: "c" }], [
    { key: "a", verdict: "candidate" },
    { key: "b", verdict: "empty" },
  ]).length,
  3,
);
expect("没有复查记录时全部保留", unresolvedTargets([{ key: "a" }], []).length, 1);
expect(
  "旧证据按新规则失效的 matched 重新算未解决（批量清单能自我修复）",
  unresolvedTargets(
    [{ key: "a" }, { key: "b" }],
    [
      {
        key: "a",
        verdict: "matched",
        evidence: { url: "https://www.nda.gov.cn/sjj/index_pc.html", title: "国家数据局" },
      },
      {
        key: "b",
        verdict: "matched",
        evidence: {
          url: "https://www.gov.cn/zhengce/content/2023-08/28/content_6900000.htm",
          title: "关于研发费用加计扣除政策的通知",
        },
      },
    ],
    (c) => matchedStillValid(c.kind ?? "citation", c.evidence, gradeCitation, c.text, "研发费用 加计扣除"),
  ).map((t) => t.key),
  ["a"],
);
expect(
  "不传判定函数时按原样保护全部 matched",
  unresolvedTargets([{ key: "a" }], [{ key: "a", verdict: "matched", evidence: null }]).length,
  0,
);
expect("保留说明带上日期与判定", preservedNote("", "empty", "2026-09-29T03:00:00.000Z").includes("2026-09-29 03:00:00"), true);
expect("保留说明接在旧 note 后面", preservedNote("旧说明", "empty", "2026-09-29T03:00:00.000Z").startsWith("旧说明；"), true);
db.prepare(`DELETE FROM ref_checks WHERE task_id = ?`).run(TASK);
expect("验证收尾清掉假任务的记录", listRefChecks(TASK).length, 0);

// 9) 不降级护栏不能把误判锁死：分级规则收紧后，旧的 matched 要能被纠正
expect("旧证据仍算官方原文时不覆盖", shouldOverwrite("matched", "empty", true), false);
expect("旧证据已不算官方原文时允许覆盖", shouldOverwrite("matched", "empty", false), true);
expect("默认参数保持保护", shouldOverwrite("matched", "empty"), false);
expect("没有旧证据时不保护", matchedStillValid("docref", null, gradeCitation), false);
// 引用替换的主题相关判据要在「旧记录是否仍站得住」上同样生效，否则收紧只对新增记录有效，
// 实测那 9 条误判会被不降级护栏永久锁死
expect(
  "引用替换：官方站点但与原引用只共用泛词 → 不再算有效",
  matchedStillValid(
    "citation",
    {
      url: "http://www.scio.gov.cn/31773/31774/31779/Document/1628713/1628713.htm",
      title: "全面认识和把握我国基本国情",
    },
    gradeCitation,
    "国情_中国政府网",
  ),
  false,
);
expect(
  "引用替换：官方站点且共用领域词 → 仍算有效",
  matchedStillValid(
    "citation",
    { url: "https://www.most.gov.cn/xxgk/a.pdf", title: "研发费用加计扣除政策执行指引" },
    gradeCitation,
    "研发 - MBA智库百科",
    "研发费用 加计扣除",
  ),
  true,
);
expect(
  "引用替换：税务机关解读页不算有效替代来源",
  matchedStillValid(
    "citation",
    {
      url: "https://www.chinatax.gov.cn/chinatax/n810341/n810760/c2922282/content.html",
      title: "研发费用加计扣除政策执行指引的解读",
    },
    gradeCitation,
    "研发 - MBA智库百科",
  ),
  false,
);
expect(
  "取不到任务主题词时不认定为有效（连结论谈什么都确定不了，宁可降为候选）",
  matchedStillValid(
    "citation",
    { url: "https://www.most.gov.cn/xxgk/a.pdf", title: "研发费用加计扣除政策执行指引" },
    gradeCitation,
    "研发 - MBA智库百科",
  ),
  false,
);
expect("空地址不保护", matchedStillValid("docref", { url: "", title: "甲" }, gradeCitation), false);
expect(
  "引用替换：门户入口页证据不受保护",
  matchedStillValid(
    "citation",
    { url: "https://www.nda.gov.cn/sjj/index_pc.html", title: "国家数据局" },
    gradeCitation,
  ),
  false,
);
expect(
  "引用替换：政策原文地址仍受保护",
  matchedStillValid(
    "citation",
    {
      url: "https://www.gov.cn/zhengce/content/2023-08/28/content_6900000.htm",
      title: "关于研发费用加计扣除政策的通知",
    },
    gradeCitation,
    "研发费用加计扣除",
    "研发费用 加计扣除",
  ),
  true,
);
expect(
  "引用替换：专业来源不够（承诺的是官方原文）",
  matchedStillValid(
    "citation",
    { url: "https://www.shui5.cn/article/ae/10559.html", title: "国税发〔2006〕187号" },
    gradeCitation,
  ),
  false,
);
expect(
  "文号复查：专业来源仍算出处（税务实务库）",
  matchedStillValid(
    "docref",
    { url: "https://www.shui5.cn/article/ae/10559.html", title: "国税发〔2006〕187号" },
    gradeCitation,
  ),
  true,
);
expect(
  "文号复查：法规 PDF 仍算出处",
  matchedStillValid(
    "docref",
    { url: "http://www.ohmi.net.cn/law/pdf/shuishou/guoshuifa200991.pdf", title: "国税发〔2009〕91号" },
    gradeCitation,
  ),
  true,
);
expect(
  "文号复查：门户首页不算出处",
  matchedStillValid("docref", { url: "https://www.chinatax.gov.cn/", title: "国家税务总局" }, gradeCitation),
  false,
);
const STALE_URL = "https://www.nda.gov.cn/sjj/index_pc.html";
const staleKey = refKey("citation", STALE_URL);
saveRefCheck(TASK, {
  key: staleKey,
  kind: "citation",
  text: "国家数据局",
  query: "国家数据局 统计数据",
  verdict: "matched",
  note: "旧规则下把门户入口页误判为官方原文",
  evidence: { title: "国家数据局", url: STALE_URL, snippet: "", grade: "official", gradeReason: "" },
  subjectUrl: "https://data.stats.gov.cn/",
  attempts: [],
  checkedAt: "2026-09-29T04:00:00.000Z",
});
expect("前置：误判记录已落库", listRefChecks(TASK)[0]?.verdict, "matched");
saveRefCheck(TASK, {
  key: staleKey,
  kind: "citation",
  text: "国家数据局",
  query: "国家数据局 统计数据",
  verdict: "candidate",
  note: "本次只找到候选页，需人工确认",
  evidence: null,
  subjectUrl: "https://data.stats.gov.cn/",
  attempts: [],
  checkedAt: "2026-09-29T06:00:00.000Z",
});
const corrected = listRefChecks(TASK)[0];
expect("误判的 matched 被纠正", corrected?.verdict, "candidate");
expect("纠正后不再保留失效证据", corrected?.evidence, null);
expect("纠正后 note 是本次说明", corrected?.note, "本次只找到候选页，需人工确认");
expect("纠正后复查时间更新", corrected?.checkedAt, "2026-09-29T06:00:00.000Z");
expect("纠正过程不新增记录", listRefChecks(TASK).length, 1);
db.prepare(`DELETE FROM ref_checks WHERE task_id = ?`).run(TASK);
expect("收尾清掉假任务记录", listRefChecks(TASK).length, 0);

// 10) 替代来源的主题相关性：官方域名只是必要条件，谈的不是同一件事就只能算候选
expect("中文按二字滑窗切词", topicTokens("研发费用").includes("研发") && topicTokens("研发费用").includes("发费"), true);
expect("英文数字取 3 字以上", topicTokens("RD 2025 加计 abc").filter((t) => /^[a-z0-9]+$/.test(t)), ["2025", "abc"]);
expect("通用词不进主题词", topicTokens("国家政务服务平台首页").includes("国家"), false);
expect("通用词「平台」不进主题词", topicTokens("国家政务服务平台首页").includes("平台"), false);
expect("切词去重", new Set(topicTokens("研发研发研发")).size, topicTokens("研发研发研发").length);
expect("空标题没有主题词", topicTokens(""), []);
ok(
  "同一主题有共同词",
  topicOverlap("研发费用加计扣除", "关于研发费用税前加计扣除政策的通知", "研发费用加计扣除比例").length > 0,
);
expect("不同主题没有共同词", topicOverlap("研发费用加计扣除", "中华人民共和国增值税暂行条例", "增值税税率调整"), []);
ok(
  "摘要里的共同词也算",
  topicOverlap("土地增值税清算", "税务事项通知", "土地增值税清算管理办法").length > 0,
);
expect("原引用全是通用词时不给相关性（宁可降为候选）", topicOverlap("国家平台", "任意标题", "任意摘要"), []);
ok(
  "粗粒度切词会保留跨词二字组合（已知局限，靠功能页规则兜住）",
  topicOverlap("国家政务服务平台", "国家税务总局12366纳税服务平台").length > 0,
);
const unrelatedOfficial = gradeRefCheck(
  {
    key: "citation:u",
    kind: "citation",
    text: "研发费用加计扣除",
    excludeUrl: "https://baike.baidu.com/x",
  },
  outcome([
    hit(
      "中华人民共和国增值税暂行条例",
      "https://www.gov.cn/zhengce/content/2023-08/28/content_6900000.htm",
      "增值税税率与应纳税额",
    ),
  ]),
);
expect("官方页但主题不相关 → 只给候选", unrelatedOfficial.verdict, "candidate");
ok("候选说明写清是主题不相关", (unrelatedOfficial.note ?? "").includes("没有共同的涉税领域词"), unrelatedOfficial.note);
expect(
  "候选仍给出证据链接",
  unrelatedOfficial.evidence?.url,
  "https://www.gov.cn/zhengce/content/2023-08/28/content_6900000.htm",
);
const relatedOfficial = gradeRefCheck(
  {
    key: "citation:r",
    kind: "citation",
    text: "研发费用加计扣除",
    hint: "研发费用 加计扣除",
    excludeUrl: "https://baike.baidu.com/x",
  },
  outcome([
    hit(
      "关于完善研发费用税前加计扣除政策的通知",
      "https://www.gov.cn/zhengce/content/2023-08/28/content_6900001.htm",
      "研发费用加计扣除比例提高至 100%",
    ),
  ]),
);
expect("官方页且主题相关 → matched", relatedOfficial.verdict, "matched");
const appDownload = gradeRefCheck(
  { key: "citation:a", kind: "citation", text: "国家政务服务平台", excludeUrl: "https://gjzwfw.gov.cn/" },
  outcome([hit("国家政务服务平台", "https://app.gjzwfw.gov.cn/fwmhapp/downloadApp/android.html", "App 下载")]),
);
expect("同域名下的 App 下载页不算官方原文", appDownload.verdict, "empty");
ok(
  "App 下载页的说明写清没有可替换的官方原文",
  (appDownload.note ?? "").includes("没有可替换的官方原文"),
  appDownload.note,
);

// 税务机关主站的解读/新闻频道页：官方发布、分级也是 official，但它是「讲这份文件的」而不是文件本身
const interpretation = gradeRefCheck(
  { key: "citation:i", kind: "citation", text: "研发费用加计扣除", excludeUrl: "https://baike.baidu.com/x" },
  outcome([
    hit(
      "关于《研发费用税前加计扣除归集范围有关问题的公告》的解读",
      "https://www.chinatax.gov.cn/chinatax/n810341/n810760/c2922282/content.html",
      "研发费用加计扣除归集范围",
    ),
  ]),
);
expect("解读页即使主题相关也不判为找到官方原文", interpretation.verdict, "candidate");
ok("解读页只作候选并要求人工确认", (interpretation.note ?? "").includes("人工确认"), interpretation.note);
// 反向护栏：收紧的只是税务主站频道页，其他官方站点的文件页与政策法规库原文页都还要能过
const otherGov = gradeRefCheck(
  {
    key: "citation:g",
    kind: "citation",
    text: "研发费用加计扣除",
    hint: "研发费用 加计扣除",
    excludeUrl: "https://baike.baidu.com/x",
  },
  outcome([
    hit(
      "研发费用加计扣除政策执行指引",
      "https://www.most.gov.cn/xxgk/2023/t20230101_1.pdf",
      "研发费用加计扣除",
    ),
  ]),
);
expect("其他政府站点的文件页仍算官方原文", otherGov.verdict, "matched");
const libraryPage = gradeRefCheck(
  {
    key: "citation:l",
    kind: "citation",
    text: "研发费用加计扣除",
    hint: "研发费用 加计扣除",
    excludeUrl: "https://baike.baidu.com/x",
  },
  outcome([
    hit(
      "关于完善研究开发费用税前加计扣除政策的通知",
      "http://fgk.chinatax.gov.cn/zcfgk/c102416/c5203882/content.html",
      "研发费用加计扣除",
    ),
  ]),
);
expect("政策法规库原文页仍算官方原文", libraryPage.verdict, "matched");
expect(
  "原引用标题就是文号时，命中同一文号的官方页仍算 matched",
  gradeRefCheck(
    {
      key: "citation:d",
      kind: "citation",
      text: "财税〔2015〕119号",
      hint: "研发费用 加计扣除",
      excludeUrl: "https://baike.baidu.com/x",
    },
    outcome([
      hit(
        "财政部 国家税务总局 科技部关于完善研究开发费用税前加计扣除政策的通知 财税〔2015〕119号",
        "https://www.most.gov.cn/xxgk/a.pdf",
        "研发费用加计扣除",
      ),
    ]),
  ).verdict,
  "matched",
);
expect(
  "文号不同则不算同一件事",
  domainOverlap("财税〔2015〕119号", "国家税务总局公告2019年第41号", "").length,
  0,
);

// 还要与「这份结论」谈同一件事：只与原引用标题共用一个词是不够的
expect("主题词与命中页共享完整领域词", onTaskTopic("土地增值税 底稿", "土地增值税清算管理规程", ""), true);
expect(
  "只共用前缀不算（土地 ≠ 土地增值税）",
  onTaskTopic("土地增值税 底稿", "中华人民共和国土地管理法实施条例", ""),
  false,
);
expect("主题词为空时返回 false，由调用方回退", onTaskTopic("", "研发费用加计扣除", ""), false);
expect(
  "研发类命中页与研发类主题词对得上",
  onTaskTopic("研发费用 加计扣除", "研发费用加计扣除 政策执行指引 （2.0版）", ""),
  true,
);
// 实测误判：结论谈土地增值税清算，却把《土地管理法实施条例》当成「土地（汉语词语）_百度百科」的替代来源
const landMis = gradeRefCheck(
  {
    key: "citation:t",
    kind: "citation",
    text: "土地（汉语词语）_百度百科",
    hint: "土地增值税 底稿",
    excludeUrl: "https://baike.baidu.com/x",
  },
  outcome([
    hit(
      "中华人民共和国土地管理法实施条例_土地_中国政府网",
      "https://www.gov.cn/zhengce/content/2023-08/28/content_6900002.htm",
      "土地管理",
    ),
  ]),
);
expect("只共用「土地」的替换不再判为找到官方原文", landMis.verdict, "candidate");
const rdOk = gradeRefCheck(
  {
    key: "citation:k",
    kind: "citation",
    text: "研发_百度百科",
    hint: "研发费用 加计扣除",
    excludeUrl: "https://baike.baidu.com/x",
  },
  outcome([
    hit("研发费用加计扣除 政策执行指引 （2.0版）", "https://www.most.gov.cn/xxgk/a.pdf", "研发费用加计扣除"),
  ]),
);
expect("与结论同主题的官方原文仍判 matched", rdOk.verdict, "matched");
expect(
  "旧记录按同一判据重算：只含土地的替代来源不再算有效",
  matchedStillValid(
    "citation",
    { url: "https://www.gov.cn/zhengce/content/x.htm", title: "中华人民共和国土地管理法实施条例" },
    gradeCitation,
    "土地（汉语词语）_百度百科",
    "土地增值税 底稿",
  ),
  false,
);
expect(
  "同主题命中页在旧记录上仍算有效",
  matchedStillValid(
    "citation",
    { url: "https://www.most.gov.cn/xxgk/a.pdf", title: "研发费用加计扣除 政策执行指引" },
    gradeCitation,
    "研发_百度百科",
    "研发费用 加计扣除",
  ),
  true,
);

// 主题相关门槛：共同词里要有涉税领域词。只共用泛词不算「谈同一件事」——通用词黑名单是手工
// 维护的，「国家」「政府」都在表里而「国情」漏了，实测因此误判过一条。
expect("领域词本身算", isDomainToken("加计扣除"), true);
expect("领域词的二字片段也算（研发 ⊂ 研发费用）", isDomainToken("研发"), true);
expect("泛词不算领域词", isDomainToken("国情"), false);
expect("空词元不算", isDomainToken(""), false);
expect(
  "只共用泛词时领域重叠为空",
  domainOverlap("国情_中国政府网", "全面认识和把握我国基本国情", "").length,
  0,
);
expect(
  "共用领域词时领域重叠非空",
  domainOverlap("研发 - MBA智库百科", "研发费用加计扣除 政策执行指引 （2.0版）", "").length > 0,
  true,
);
// 实测误判的那一条：弱证据「国情_中国政府网」曾被换成 gov.cn 上的《全面认识和把握我国基本国情》
const genericOnly = gradeRefCheck(
  { key: "citation:n", kind: "citation", text: "国情_中国政府网", excludeUrl: "https://baike.baidu.com/x" },
  outcome([
    hit(
      "全面认识和把握我国基本国情",
      "http://www.scio.gov.cn/31773/31774/31779/Document/1628713/1628713.htm",
      "",
    ),
  ]),
);
expect("只共用泛词时不再判为找到官方原文", genericOnly.verdict, "candidate");
ok(
  "候选说明写清是没有共同领域词",
  (genericOnly.note ?? "").includes("没有共同的涉税领域词"),
  genericOnly.note,
);
// 10) 官方政策法规库定向检索：按发文字号精确命中，未命中如实退回通用检索
// 通用搜索引擎对中文长查询已退化（Bing 忽略 site:、只命中「国家」二字返回百科词条，百度安全验证），
// 政策文号改走官方库，命中门槛是发文字号归一化后全等。
expect(
  "有发文机关时给出完整发文字号",
  policyDocNumQuery({
    key: refKey("docref", "2019年第41号"),
    kind: "docref",
    text: "2019年第41号",
    context: "已按国家税务总局公告2019年第41号自2019年度起废止",
  }),
  "国家税务总局公告2019年第41号",
);
expect(
  "联合发文补齐全部机关",
  policyDocNumQuery({
    key: refKey("docref", "2022年第28号"),
    kind: "docref",
    text: "2022年第28号",
    context: "财政部 税务总局 科技部公告2022年第28号同时废止",
  }),
  "财政部 税务总局 科技部公告2022年第28号",
);
expect(
  "上下文没有发文机关时不走政策法规库",
  policyDocNumQuery({
    key: refKey("docref", "2022年第28号"),
    kind: "docref",
    text: "2022年第28号",
    context: "同时废止 2021年第13号、2022年第16号、2022年第28号",
  }),
  "",
);
expect(
  "引用类复查不走政策法规库",
  policyDocNumQuery({ key: "citation:x", kind: "citation", text: "研发_百度百科" }),
  "",
);

const LIB_HITS: PolicyLibraryHit[] = [
  {
    docNum: "国家税务总局公告2019年第41号",
    title: "国家税务总局关于修订企业所得税年度纳税申报表有关问题的公告",
    url: "http://fgk.chinatax.gov.cn/zcfgk/c100012/c5194895/content.html",
    pubDate: "2019-12-31",
  },
  {
    docNum: "财政部 税务总局 国家发展改革委 工业和信息化部公告2026年第23号",
    title: "关于集成电路企业、工业母机企业非货币性资产投资",
    url: "http://fgk.chinatax.gov.cn/zcfgk/c102416/c5251766/content.html",
    pubDate: "2026-01-01",
  },
  { docNum: "", title: "国家税务总局例行新闻发布会实录", url: "https://www.chinatax.gov.cn/chinatax/n810219/c5248.html", pubDate: "" },
];
expect(
  "按发文字号精确命中",
  matchPolicyDocNum("国家税务总局公告2019年第41号", LIB_HITS)?.url,
  "http://fgk.chinatax.gov.cn/zcfgk/c100012/c5194895/content.html",
);
expect("写法带空格也能命中", matchPolicyDocNum("国家税务总局公告 2019年第41号", LIB_HITS)?.pubDate, "2019-12-31");
expect(
  "后续替代文件不算命中（查 2023年第44号 不认成 2026年第23号）",
  matchPolicyDocNum("财政部 税务总局 国家发展改革委 工业和信息化部公告2023年第44号", LIB_HITS),
  null,
);
expect("光杆文号不猜机关，永不命中", matchPolicyDocNum("2019年第41号", LIB_HITS), null);
expect("空发文字号不参与匹配", matchPolicyDocNum("", LIB_HITS), null);
expect("发文字号归一化", normalizeDocNum("财税〔2015〕 119号"), "财税[2015]119号");

// 响应解析：结果数组挂在 searchResultAll.searchTotal（名字有迷惑性），标题带 <em> 高亮
const parsedLib = parsePolicyLibrary({
  searchResultAll: {
    total: 3,
    searchTotal: [
      {
        title: "国家<em>税务总局</em>公告",
        url: "http://fgk.chinatax.gov.cn/zcfgk/c1/a.html",
        pubDate: "2019-12-31",
        govDoc: { docNum: "国家税务总局公告2019年第41号" },
      },
      { title: "没有可用地址的条目", url: "", govDoc: { docNum: "x" } },
      { title: "缺 govDoc 的条目", url: "https://www.chinatax.gov.cn/b.html" },
    ],
  },
});
expect("只保留有可用地址的条目", parsedLib.hits.length, 2);
expect("命中总数取 total 字段", parsedLib.total, 3);
expect("标题去掉高亮标记", parsedLib.hits[0]?.title, "国家税务总局公告");
expect("缺 govDoc 时发文字号为空串", parsedLib.hits[1]?.docNum, "");
expect("响应为 null 不抛错", parsePolicyLibrary(null).hits.length, 0);
expect("结果数组缺失不抛错", parsePolicyLibrary({ searchResultAll: {} }).hits.length, 0);

// 全链路：库内精确命中即定为找到出处且不再走通用检索；未命中或接口失败都退回通用检索
const LIB_TASK = "__verify_refcheck_lib__";
const clearLib = () => db.prepare(`DELETE FROM ref_checks WHERE task_id = ?`).run(LIB_TASK);
// 第 10、11 节要测的是检索与护栏本身，必须关掉跨任务复用：本节刚存下的官方原文会被下一节的
// 复用路径直接拿走，那样就测不到「政策法规库未命中退回通用检索」与「商业站点顶不掉官方原文」。
const noDocs: Map<string, VerifiedOfficialDoc> = new Map();
const libTarget: RefCheckTarget = {
  key: refKey("docref", "2019年第41号"),
  kind: "docref",
  text: "2019年第41号",
  context: "已按国家税务总局公告2019年第41号自2019年度起废止",
};
const webHit: Searcher = async () =>
  ({
    results: [
      hit(
        "国家税务总局公告2019年第41号 全文",
        "http://fgk.chinatax.gov.cn/zcfgk/c100012/c5194895/content.html",
        "年度纳税申报表",
      ),
    ],
    attempts: [attempt("ok", "保留 1 条")],
    minScore: 2,
  }) satisfies DetailedSearch;

clearLib();
const libRan = await runRefChecks(
  LIB_TASK,
  [libTarget],
  async () => {
    throw new Error("政策法规库已精确命中，不应再走通用检索");
  },
  async () => ({ hits: LIB_HITS, total: 1, status: 200, error: null }),
  noDocs,
);
expect("政策法规库精确命中判为找到出处", libRan[0]?.verdict, "matched");
ok("说明写明来自政策法规库", (libRan[0]?.note ?? "").includes("政策法规库"), libRan[0]?.note);
expect(
  "证据地址为官方原文页",
  libRan[0]?.evidence?.url,
  "http://fgk.chinatax.gov.cn/zcfgk/c100012/c5194895/content.html",
);
expect("证据分级为官方原文", libRan[0]?.evidence?.grade, "official");
expect("证据摘要存发文字号", libRan[0]?.evidence?.snippet, "国家税务总局公告2019年第41号");
expect("检索词记为完整发文字号", libRan[0]?.query, "国家税务总局公告2019年第41号");
expect(
  "政策法规库这一路留痕",
  libRan[0]?.attempts.some((a) => a.engine === "fgk" && a.status === "ok" && a.via === "JSON"),
  true,
);

clearLib();
const missLib: PolicySearcher = async () => ({ hits: [LIB_HITS[1]!], total: 6, status: 200, error: null });
const libMiss = await runRefChecks(LIB_TASK, [libTarget], webHit, missLib, noDocs);
expect("库内无相符发文字号时退回通用检索", libMiss[0]?.verdict, "matched");
ok(
  "未命中时如实说明库内没有发文字号相符的",
  (libMiss[0]?.attempts ?? []).some((a) => a.engine === "fgk" && a.note.includes("无发文字号完全相符")),
  JSON.stringify(libMiss[0]?.attempts),
);
expect("退回通用检索后两路都留痕", libMiss[0]?.attempts.length, 2);

clearLib();
const errLib: PolicySearcher = async () => ({ hits: [], total: 0, status: null, error: "接口超时" });
const libErr = await runRefChecks(LIB_TASK, [libTarget], webHit, errLib, noDocs);
expect("政策法规库接口失败不影响通用检索", libErr[0]?.verdict, "matched");
expect(
  "接口失败如实记为 error",
  libErr[0]?.attempts.find((a) => a.engine === "fgk")?.status,
  "error",
);
clearLib();

// 11) 证据升级通道：商业站点换成政策法规库官方原文，且反向替换必须被挡住
expect("旧证据官方、新证据官方 → 可替换", evidenceCanReplace("docref", "official", "official"), true);
expect("旧证据官方、新证据专业 → 不可替换", evidenceCanReplace("docref", "official", "professional"), false);
expect("旧证据专业、新证据官方 → 可升级", evidenceCanReplace("docref", "professional", "official"), true);
expect("旧证据专业、新证据专业 → 可平移", evidenceCanReplace("docref", "professional", "professional"), true);
expect("没有旧证据时不设限", evidenceCanReplace("docref", null, "professional"), true);
expect("引用类另有官方门槛，这里不重复管", evidenceCanReplace("citation", "official", "professional"), true);
ok(
  "保留原因写清是证据力不及",
  keptBetterNote("", "professional", "2026-09-29T10:00:00.000Z").includes("不及已留存的官方原文"),
  keptBetterNote("", "professional", "2026-09-29T10:00:00.000Z"),
);
ok(
  "保留说明追加在原 note 之后而不是覆盖",
  keptBetterNote("原有说明", "professional", "2026-09-29T10:00:00.000Z").startsWith("原有说明；"),
);

// 升级候选来自真实数据：只挑已 matched 但证据非官方、且能构造完整发文字号的文号
const upAll = listTasks().flatMap((t) => upgradeRefTargets(t.id).map((x) => ({ id: t.id, x })));
expect("升级候选都是文号类", upAll.every((o) => o.x.kind === "docref"), true);
ok(
  "升级候选都能构造完整发文字号（机关不明的不进清单）",
  upAll.every((o) => policyDocNumQuery(o.x) !== ""),
  JSON.stringify(upAll.slice(0, 3).map((o) => o.x.text)),
);
ok(
  "升级候选不与同任务未解决项重叠（预算不会被同一文号占两次）",
  upAll.every((o) => !pendingRefTargets(o.id).some((p) => p.key === o.x.key)),
);
console.log(`[verify] 升级候选 ${upAll.length} 条（已 matched 但证据非官方原文）`);

// 落库双向：官方原文顶不掉，专业来源可以被官方原文升级
const GUARD_TASK = "__verify_refcheck_guard__";
const clearGuard = () => db.prepare(`DELETE FROM ref_checks WHERE task_id = ?`).run(GUARD_TASK);
const guardTarget: RefCheckTarget = {
  key: refKey("docref", "2019年第41号"),
  kind: "docref",
  text: "2019年第41号",
  context: "已按国家税务总局公告2019年第41号自2019年度起废止",
};
const proSearcher: Searcher = async () =>
  ({
    results: [
      hit(
        "国家税务总局公告2019年第41号 全文",
        "https://www.shui5.cn/article/36/143141.html",
        "年度纳税申报表",
      ),
    ],
    attempts: [attempt("ok", "保留 1 条")],
    minScore: 2,
  }) satisfies DetailedSearch;
const libHit: PolicySearcher = async () => ({ hits: LIB_HITS, total: 1, status: 200, error: null });
const libMiss2: PolicySearcher = async () => ({ hits: [], total: 0, status: 200, error: null });

clearGuard();
await runRefChecks(GUARD_TASK, [guardTarget], webHit, libHit, noDocs);
expect("前置：证据已是官方原文", listRefChecks(GUARD_TASK)[0]?.evidence?.grade, "official");
const downgraded = await runRefChecks(GUARD_TASK, [guardTarget], proSearcher, libMiss2, noDocs);
expect("商业站点顶不掉官方原文", listRefChecks(GUARD_TASK)[0]?.evidence?.grade, "official");
expect(
  "证据地址没被换掉",
  listRefChecks(GUARD_TASK)[0]?.evidence?.url,
  "http://fgk.chinatax.gov.cn/zcfgk/c100012/c5194895/content.html",
);
expect("仍记为找到出处", downgraded[0]?.verdict, "matched");
ok(
  "note 说明为何保留官方原文",
  (listRefChecks(GUARD_TASK)[0]?.note ?? "").includes("不及已留存的官方原文"),
  listRefChecks(GUARD_TASK)[0]?.note,
);
ok(
  "被挡下的这次尝试照样留痕",
  (listRefChecks(GUARD_TASK)[0]?.attempts ?? []).length >= 2,
  JSON.stringify(listRefChecks(GUARD_TASK)[0]?.attempts?.length),
);

clearGuard();
await runRefChecks(GUARD_TASK, [guardTarget], proSearcher, libMiss2, noDocs);
expect("前置：先记为专业来源", listRefChecks(GUARD_TASK)[0]?.evidence?.grade, "professional");
await runRefChecks(GUARD_TASK, [guardTarget], webHit, libHit, noDocs);
expect("官方原文可以顶掉专业来源", listRefChecks(GUARD_TASK)[0]?.evidence?.grade, "official");
expect("升级后仍是一条记录", listRefChecks(GUARD_TASK).length, 1);
clearGuard();

// 12) 跨任务复用已核实的官方原文：命中索引就不发任何网络请求
expect(
  "snippet 是完整字号时可复用",
  reusableDocNum("〔2010〕220号", "国税函〔2010〕220号"),
  "国税函[2010]220号",
);
expect("snippet 与文号相同（没补出机关）时不可复用", reusableDocNum("〔2010〕220号", "〔2010〕220号"), "");
expect("snippet 是页面正文时不可复用", reusableDocNum("〔2010〕220号", "国家税务总局关于清算有关问题的通知 阅读量"), "");
expect("空值不可复用", reusableDocNum("", ""), "");
// 通用检索命中的记录 snippet 是页面正文，但当时的检索词恰好就是完整发文字号（实测数据）
expect(
  "snippet 是页面正文时退回检索词取字号",
  reusableDocNum(
    "2015年第97号",
    "1.根据《归集范围公告》（国家税务总局公告2017年第40号）的规定，国家税务总局公告2015年第97号第一条同时废止",
    "国家税务总局公告2015年第97号",
  ),
  "国家税务总局公告2015年第97号",
);
expect(
  "联合发文的检索词同样可用（归一化后去掉机关间空格）",
  reusableDocNum(
    "2022年第28号",
    "财政部 税务总局 科技部关于加大支持科技创新税前扣除力度的公告 字体：【大】【中】【小】",
    "财政部 税务总局 科技部公告2022年第28号",
  ),
  "财政部税务总局科技部公告2022年第28号",
);
expect(
  "带上下文关键词的检索词不以文号结尾，不采用",
  reusableDocNum("〔2015〕119号", "", "财税〔2015〕119号 企业研发费用加计扣除比例"),
  "",
);
expect(
  "机关部分不可信时不采用（关键词与机关黏成一段）",
  reusableDocNum("〔2015〕119号", "", "研发费用加计扣除财税〔2015〕119号"),
  "",
);
expect("短机关代号可用", reusableDocNum("〔2015〕119号", "", "财税〔2015〕119号"), "财税[2015]119号");
expect("机关以公文种类词结尾时可用", reusableDocNum("〔2010〕220号", "", "国税函〔2010〕220号"), "国税函[2010]220号");
console.log(`[verify] 已核实官方原文索引 ${verifiedOfficialDocs().size} 条（含通用检索命中、靠检索词补出字号的）`);

const REUSE_SRC = "__verify_refcheck_reuse_src__";
const REUSE_DST = "__verify_refcheck_reuse_dst__";
const REUSE_URL = "http://fgk.chinatax.gov.cn/zcfgk/c100012/c9999999/content.html";
const clearReuse = () => {
  db.prepare(`DELETE FROM ref_checks WHERE task_id = ?`).run(REUSE_SRC);
  db.prepare(`DELETE FROM ref_checks WHERE task_id = ?`).run(REUSE_DST);
};
clearReuse();
saveRefCheck(REUSE_SRC, {
  key: refKey("docref", "〔2099〕999号"),
  kind: "docref",
  text: "〔2099〕999号",
  query: "国税函〔2099〕999号",
  verdict: "matched",
  note: "国家税务总局政策法规库按发文字号精确命中，链接为官方原文页",
  evidence: {
    title: "国家税务总局关于验证用虚构文件的通知",
    url: REUSE_URL,
    snippet: "国税函〔2099〕999号",
    grade: "official",
    gradeReason: "",
  },
  subjectUrl: "",
  attempts: [],
  checkedAt: "2026-09-29T10:00:00.000Z",
});
expect("索引键为归一化后的完整发文字号", verifiedOfficialDocs().get("国税函[2099]999号")?.evidence.grade, "official");
expect("索引记下最初核实的任务", verifiedOfficialDocs().get("国税函[2099]999号")?.taskId, REUSE_SRC);

const reuseTarget: RefCheckTarget = {
  key: refKey("docref", "〔2099〕999号"),
  kind: "docref",
  text: "〔2099〕999号",
  context: "打开成功，确认为国税函〔2099〕999号原文",
};
const reused = await runRefChecks(
  REUSE_DST,
  [reuseTarget],
  async () => {
    throw new Error("复用已核实证据时不应发起通用检索");
  },
  async () => {
    throw new Error("复用已核实证据时不应发起政策法规库检索");
  },
);
expect("复用即判为找到出处", reused[0]?.verdict, "matched");
expect("证据地址来自已核实记录", reused[0]?.evidence?.url, REUSE_URL);
expect("证据分级为官方原文", reused[0]?.evidence?.grade, "official");
ok("note 说明是复用而不是新检索", (reused[0]?.note ?? "").includes("复用"), reused[0]?.note);
ok(
  "留痕写明本次未发起检索",
  (reused[0]?.attempts ?? []).some((a) => a.engine === "fgk" && a.note.includes("本次未发起检索")),
  JSON.stringify(reused[0]?.attempts),
);
expect("复用结果同样落库", listRefChecks(REUSE_DST).length, 1);

// 索引不收非官方证据：换成商业站点后同一字号不应再被复用
clearReuse();
saveRefCheck(REUSE_SRC, {
  key: refKey("docref", "〔2099〕999号"),
  kind: "docref",
  text: "〔2099〕999号",
  query: "国税函〔2099〕999号",
  verdict: "matched",
  note: "公开检索结果的标题或摘要中出现该文号",
  evidence: {
    title: "国税函〔2099〕999号 全文",
    url: "https://www.shui5.cn/article/x/1.html",
    snippet: "国税函〔2099〕999号",
    grade: "professional",
    gradeReason: "",
  },
  subjectUrl: "",
  attempts: [],
  checkedAt: "2026-09-29T10:00:00.000Z",
});
expect("非官方证据不进索引", verifiedOfficialDocs().has("国税函[2099]999号"), false);
clearReuse();

console.log(`[verify] 文号复查检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 政策文号复查规则不符");
  process.exit(1);
}
console.log("[PASS] 政策文号复查正确（检索词构造 / 四级判定 / 落库往返与覆盖 / 真实任务走查）");
