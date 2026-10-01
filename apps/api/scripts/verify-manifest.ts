/**
 * 验证脚本：交付包 manifest.json（结构、内部一致性自校验、真实任务走查）。
 * 运行：pnpm verify:manifest
 */
import fs from "node:fs";
import path from "node:path";
import { buildManifest, MANIFEST_SCHEMA, MANIFEST_VERSION, manifestIssues, type ManifestInput } from "../../web/src/manifest.ts";
import { deliveryCheck } from "../../web/src/delivery-check.ts";
import { artifactSources } from "../../web/src/artifact-sources.ts";
import { artifactsOfRun, runWindows } from "../../web/src/run-artifacts.ts";
import {
  traceAmounts,
  amountKey,
  classifyUntraced,
  TEXT_AMOUNT_TOOLS,
  UNTRACED_ORIGIN_TEXT,
} from "../../web/src/amount-trace.ts";
import { amountSection, AMOUNT_TABLE_LIMIT } from "../../web/src/delivery-amount.ts";
import { parseDetail, parsedByFileName } from "../../web/src/file-parse.ts";
import { reviewCounts } from "../../web/src/review-export.ts";
import { normalizeRef, traceDocRefs } from "../../web/src/policy-trace.ts";
import { gradeCitation, summarizeGrades } from "../../web/src/citation-grade.ts";
import {
  extractCitations,
  extractTextCitations,
  UNCAPPED,
  mergeCitations,
  SEARCH_TOOL_NAMES,
  searchEvidence,
} from "../../web/src/search-evidence.ts";
import {
  disclaimedWeakUrls,
  offTopicCitationTitles,
  summarizeRefChecks,
  uncitedWeakItems,
} from "../../web/src/ref-check.ts";
import { deltaVerdict, evidenceDelta, evidenceSnapshot } from "../../web/src/revision-impact.ts";
import {
  ageHours,
  linkVerdict,
  liveLinkChecks,
  summarizeLinkChecks,
  type LinkCheckLike,
} from "../../web/src/link-check.ts";
import { db } from "../src/db.ts";
import { dirs } from "../src/config.ts";
import { listAmountChecks } from "../src/services/amount-checks.ts";
import { listRefChecks } from "../src/services/ref-checks.ts";
import { listLinkChecks } from "../src/services/link-checks.ts";
import { extractIssues, listReviews, pendingReviewIssues } from "../src/services/issues.ts";
import { getTask, listConclusions, listFiles, listTasks } from "../src/services/task-store.ts";
import { computePlatformStats } from "../src/services/stats.ts";
import { docRefSection } from "../../web/src/delivery-docref.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

type ManifestCitation = ManifestInput["citations"][number];

/**
 * 与前端同一口径：引用提取走 search-evidence.ts（工具留存 + 结论正文），验证脚本不另写一套。
 *
 * 上限必须显式传 UNCAPPED：前端交付包用的是 allCitations（不截断），而 extractCitations /
 * mergeCitations 的默认值是给界面胶囊用的 20 / 24 条。此前漏传，交付包这一侧被截到 24 条，
 * 于是交叉核对报出「台账 41 ≠ 交付包 24」「看板 204 ≠ 交付包累加 174」——错的是本脚本，
 * 不是产品：注释写着「与前端同一口径」，实现却没跟上前端的不截断口径。
 */
function citationsOf(
  calls: Array<{ toolName: string; result: unknown }>,
  result: string,
  checks: Map<string, LinkCheckLike> = new Map(),
): ManifestCitation[] {
  return mergeCitations(
    extractCitations(calls, UNCAPPED),
    extractTextCitations(result, UNCAPPED),
    UNCAPPED,
  ).map((c) => {
    const g = gradeCitation(c.url, c.title);
    const chk = checks.get(c.url);
    return {
      title: c.title,
      url: c.url,
      // 与结果页同一口径：核验过的写判定结果，没核验过的如实写 unchecked，不猜
      verdict: chk ? linkVerdict(chk) : "unchecked",
      status: chk?.status ?? null,
      grade: g.grade,
      gradeReason: g.reason,
      via: c.via,
    };
  });
}

const delivery = deliveryCheck({
  status: "completed",
  resultChars: 1200,
  artifacts: 1,
  unattributedArtifacts: 0,
  toolTotal: 4,
  toolFailed: 0,
  toolRunning: 0,
  pendingReview: 0,
  citations: 2,
  citationGrades: { total: 2, official: 1, professional: 1, weak: 0 },
  offTopicCitations: [],
  searches: { calls: 2, withUrls: 2, metadataOnly: 0, reportedResults: 0 },
  linkCheck: { total: 2, ok: 1, blocked: 1, dead: 0, unreachable: 0 },
  linkCheckAgeHours: 1,
  amountTotal: 10,
  amountUntraced: 0,
  amountPendingWeb: 0,
  amountPendingUnexplained: 0,
  filesTotal: 1,
  filesFailed: 0,
  docRefTotal: 2,
  docRefTraced: 1,
  docRefUnverifiable: 1,
  docRefUntraced: 0,
  docRefRecheck: null,
  docRefPending: 1,
  citationRecheck: null,
  revision: null,
});

const base: ManifestInput = {
  task: {
    id: "t1",
    title: "示例任务",
    caseId: "DEMO-001",
    agentId: "rd-audit",
    status: "completed",
    createdAt: "2026-09-28T00:00:00.000Z",
    runCount: 1,
  },
  delivery,
  files: [
    {
      name: "辅助账.xlsx",
      type: "xlsx",
      byteSize: 7010,
      uploadedAt: "2026-09-28T01:00:00.000Z",
      parseStatus: "已解析",
      parseDetail: "2 个工作表 · 12 行 · 最多 2 列",
    },
  ],
  artifacts: [
    {
      name: "底稿.xlsx",
      byteSize: 12476,
      updatedAt: "2026-09-28T02:00:00.000Z",
      sourceTool: "generate_workpaper",
      sourceRole: "producer",
      sourceAt: "2026-09-28T02:00:00.000Z",
      run: 1,
    },
  ],
  tools: { total: 4, ok: 4, failed: 0, running: 0, avgMs: 30 },
  citations: [
    {
      title: "政策",
      url: "https://x.gov.cn/a/b.html",
      verdict: "ok",
      status: 200,
      grade: "official",
      gradeReason: "政府/税务机关站点的具体文件页",
      via: "fetch_content",
    },
    {
      title: "案例",
      url: "https://y.cn/b",
      verdict: "blocked",
      status: 403,
      grade: "professional",
      gradeReason: "专业机构或社区的具体文章页",
      via: "search_public_cases",
    },
  ],
  citationGrades: { total: 2, official: 1, professional: 1, weak: 0 },
  searches: {
    calls: 3,
    withUrls: 2,
    metadataOnly: 1,
    reportedResults: 6,
    queries: ["研发费用加计扣除 留存备查资料"],
    providers: ["exa"],
    tools: ["search_public_cases", "fetch_content", "web_search"],
  },
  linkCheck: {
    summary: { total: 2, ok: 1, blocked: 1, dead: 0, unreachable: 0 },
    checkedAt: "2026-09-28T03:00:00.000Z",
  },
  refChecks: {
    total: 2,
    matched: 1,
    candidate: 1,
    empty: 0,
    error: 0,
    checkedAt: "2026-09-29T02:00:00.000Z",
  },
  citationChecks: {
    total: 3,
    matched: 2,
    candidate: 0,
    empty: 1,
    error: 0,
    checkedAt: "2026-09-29T03:00:00.000Z",
  },
  revision: {
    before: { citations: 3, official: 1, professional: 1, weak: 1, weakDisclaimed: 0, docRefs: 2 },
    after: { citations: 3, official: 2, professional: 1, weak: 0, weakDisclaimed: 0, docRefs: 2 },
    verdict: "证据质量改善",
  },
  amounts: { total: 10, traced: 8, fromInput: 1, pending: 1, acked: 0, pendingWeb: 1, pendingUnexplained: 0 },
  review: { issues: 3, done: 3, pending: 0, notRequired: 0 },
};

const m = buildManifest({ ...base, generatedAt: "2026-09-28T12:00:00.000Z" });
expect("schema 与版本", [m.schema, m.version], [MANIFEST_SCHEMA, MANIFEST_VERSION]);
expect("生成时间可指定（保证可重复）", m.generatedAt, "2026-09-28T12:00:00.000Z");
expect("自洽清单无问题", manifestIssues(m), []);
expect("可序列化为 JSON", typeof JSON.stringify(m), "string");

// 逐项破坏一致性，确认自校验能发现
expect("阻断计数被改会发现", manifestIssues({ ...m, delivery: { ...m.delivery, blocks: 9 } }).length > 0, true);
expect(
  "结论与分级不符会发现",
  manifestIssues({ ...m, delivery: { ...m.delivery, verdict: "不建议直接交付" } }).some((s) => s.includes("交付结论")),
  true,
);
expect("金额总数不符会发现", manifestIssues({ ...m, amounts: { ...m.amounts, total: 11 } }).length > 0, true);
// 待确认金额的两类拆分也要能被自校验拦住：交付包里出现「合计 85、分类加起来 61」就是账不平
expect(
  "两类之和与待确认总数不符会发现",
  manifestIssues({ ...m, amounts: { ...m.amounts, pendingWeb: 99 } }).some((s) => s.includes("待确认金额两类之和")),
  true,
);
expect(
  "分类计数为负会发现",
  manifestIssues({ ...m, amounts: { ...m.amounts, pendingUnexplained: -1 } }).some((s) =>
    s.includes("分类计数出现负数"),
  ),
  true,
);
expect(
  "样例清单的两类拆分本身是平的（不是靠断言放水）",
  m.amounts.pendingWeb + m.amounts.pendingUnexplained,
  m.amounts.pending,
);
expect("工具总数不符会发现", manifestIssues({ ...m, tools: { ...m.tools, total: 5 } }).length > 0, true);
expect("复核总数不符会发现", manifestIssues({ ...m, review: { ...m.review, issues: 4 } }).length > 0, true);
expect(
  "链接核验多于引用会发现",
  manifestIssues({ ...m, linkCheck: { summary: { total: 9, ok: 9, blocked: 0, dead: 0, unreachable: 0 }, checkedAt: null } })
    .length > 0,
  true,
);
expect(
  "产物有来源类型却无工具会发现",
  manifestIssues({ ...m, artifacts: [{ ...m.artifacts[0]!, sourceTool: null }] }).length > 0,
  true,
);
expect("缺任务 ID 会发现", manifestIssues({ ...m, task: { ...m.task, id: "" } }).length > 0, true);
expect(
  "引用分级四类之和不符会发现",
  manifestIssues({ ...m, citationGrades: { total: 2, official: 2, professional: 1, weak: 0 } }).some((s) =>
    s.includes("证据力分级四类之和"),
  ),
  true,
);
expect(
  "分级总数与引用条数不符会发现",
  manifestIssues({ ...m, citationGrades: { total: 5, official: 1, professional: 1, weak: 3 } }).some((s) =>
    s.includes("分级总数与引用条数不符"),
  ),
  true,
);
expect(
  "有引用却缺分级汇总会发现",
  manifestIssues({ ...m, citationGrades: null }).some((s) => s.includes("缺少证据力分级汇总")),
  true,
);
expect(
  "引用缺分级会发现",
  manifestIssues({ ...m, citations: [{ ...m.citations[0]!, grade: "" }] }).some((s) => s.includes("缺少证据力分级")),
  true,
);
expect(
  "分级取值非法会发现",
  manifestIssues({ ...m, citations: [{ ...m.citations[0]!, grade: "maybe" }] }).some((s) =>
    s.includes("证据力分级取值非法"),
  ),
  true,
);
expect(
  "检索留痕两类之和不符会发现",
  manifestIssues({ ...m, searches: { ...m.searches!, calls: 9 } }).some((s) => s.includes("两类之和不等于调用数")),
  true,
);
expect(
  "有检索却无工具名会发现",
  manifestIssues({ ...m, searches: { ...m.searches!, tools: [] } }).some((s) => s.includes("没有工具名")),
  true,
);
expect(
  "有引用却没有留下来源的检索会发现",
  manifestIssues({ ...m, searches: { ...m.searches!, withUrls: 0, metadataOnly: 3 } }).some((s) =>
    s.includes("没有任何留下来源的检索调用"),
  ),
  true,
);
expect(
  "有引用却缺检索留痕会发现",
  manifestIssues({ ...m, searches: null }).some((s) => s.includes("缺少检索留痕汇总")),
  true,
);
expect(
  "引用缺来源工具会发现",
  manifestIssues({ ...m, citations: [{ ...m.citations[0]!, via: "" }] }).some((s) => s.includes("缺少来源工具")),
  true,
);
expect(
  "文号复查四类之和不符会发现",
  manifestIssues({ ...m, refChecks: { ...m.refChecks!, total: 5 } }).some((s) => s.includes("复查四类之和")),
  true,
);
expect(
  "有复查却无时间会发现",
  manifestIssues({ ...m, refChecks: { ...m.refChecks!, checkedAt: null } }).some((s) => s.includes("没有复查时间")),
  true,
);
expect("从未复查时为 null 不算问题", manifestIssues({ ...m, refChecks: null }).some((s) => s.includes("复查")), false);
expect(
  "弱证据引用检索四类之和不符会发现",
  manifestIssues({ ...m, citationChecks: { ...m.citationChecks!, total: 9 } }).some((s) =>
    s.includes("弱证据引用检索四类之和"),
  ),
  true,
);
expect(
  "弱证据引用检索缺时间会发现",
  manifestIssues({ ...m, citationChecks: { ...m.citationChecks!, checkedAt: null } }).some((s) =>
    s.includes("却没有时间"),
  ),
  true,
);
expect(
  "从未检索替代来源时为 null 不算问题",
  manifestIssues({ ...m, citationChecks: null }).some((s) => s.includes("弱证据引用检索")),
  false,
);
expect(
  "修订影响判断与数值不符会发现",
  manifestIssues({ ...m, revision: { ...m.revision!, verdict: "证据质量退步，请核对本次修订" } }).some((s) =>
    s.includes("修订影响判断"),
  ),
  true,
);
expect(
  "修订前快照不自洽会发现",
  manifestIssues({ ...m, revision: { ...m.revision!, before: { ...m.revision!.before, citations: 9 } } }).some((s) =>
    s.includes("修订前快照分级之和"),
  ),
  true,
);
expect(
  "快照计数为负会发现",
  manifestIssues({ ...m, revision: { ...m.revision!, after: { ...m.revision!.after, weak: -1, citations: 2 } } }).some(
    (s) => s.includes("计数出现负数"),
  ),
  true,
);
expect(
  "没有可对比结论时 revision 为 null 不算问题",
  manifestIssues({ ...m, revision: null }).some((s) => s.includes("修订")),
  false,
);
expect(
  "无引用时分级汇总为 null 不算分级问题",
  manifestIssues({
    ...m,
    citations: [],
    citationGrades: null,
    linkCheck: { summary: null, checkedAt: null },
  }).some((s) => s.includes("证据力")),
  false,
);

// 真实任务走查：用数据库与产物目录组装清单，必须自洽
let built = 0;
const gradeTotals = { total: 0, official: 0, professional: 0, weak: 0 };
let tasksWithCitations = 0;
/** 链接核验的真实规模：任一为 0 都说明 manifest 的这一节与引用的 verdict 列仍是空跑 */
let linkTasks = 0;
let linkRowsTotal = 0;
let linkStaleTotal = 0;
let citesWithVerdict = 0;
/** 真的被组装进 manifest 的链接核验汇总条数：为 0 说明这一节又被写回 null 了，自校验会静默跳过 */
let manifestLinkSummaries = 0;
/**
 * 交叉核对：manifest 走的是「前端交付路径」（web 侧纯函数 + 自己从库取数），看板与台账走的是
 * 「服务端聚合路径」（stats.ts）。两条路径各算一遍同一批指标，此前从来没有逐项对过——
 * verify:ledger 对的是台账合计 vs 看板聚合，而那两边同源于 stats.ts，等于自己跟自己比。
 * 这里把两条**独立**路径拉到一起：任务级比台账行，平台级比 evidence 聚合，交付 MD 比它写在
 * 人读那一行里的数字。三处对不上任何一处都算失败。
 */
const platform = computePlatformStats().evidence;
const rowByTask = new Map(platform.ledger.map((r) => [r.taskId, r]));
const cross = {
  docRefTotal: 0,
  docRefTraced: 0,
  docRefTracedByBody: 0,
  docRefTracedByRecheck: 0,
  docRefPending: 0,
  docRefMatched: 0,
  citations: 0,
  official: 0,
  weak: 0,
  searchCalls: 0,
  searchMetadataOnly: 0,
  amountTotal: 0,
  amountPending: 0,
  amountPendingWeb: 0,
  amountPendingUnexplained: 0,
  mdChecked: 0,
  mdAmountChecked: 0,
};
let rowsCompared = 0;
let pairChecks = 0;
let conclusionRows = 0;
let skippedTasks = 0;
let skippedCites = 0;
for (const t of listTasks()) {
  checks += 1;
  const detail = getTask(t.id);
  const callRows = db
    .prepare(`SELECT id, tool_name, args, result, ok, started_at, ended_at FROM tool_calls WHERE task_id = ? ORDER BY started_at ASC`)
    .all(t.id) as Array<{
    id: string;
    tool_name: string;
    result: string | null;
    ok: number | null;
    started_at: string;
    ended_at: string | null;
  }>;
  const calls = callRows.map((c) => {
    let result: unknown = null;
    try {
      result = c.result ? JSON.parse(c.result) : null;
    } catch {
      result = null;
    }
    return {
      id: c.id,
      toolName: c.tool_name,
      at: c.started_at,
      endedAt: c.ended_at,
      ok: c.ok === 1 ? true : c.ok === 0 ? false : null,
      result,
    };
  });
  const dir = path.join(dirs.outputs, t.id);
  const artNames = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile())
    : [];
  const src = artifactSources(artNames, calls);
  const events = db.prepare(`SELECT kind, at FROM events WHERE task_id = ? ORDER BY seq ASC`).all(t.id) as Array<{
    kind: string;
    at: string;
  }>;
  const wins = runWindows(events);
  const parsed = parsedByFileName(calls);
  const ackRows = listAmountChecks(t.id);
  const acked = new Set(ackRows.map((c) => c.key));
  const amounts = traceAmounts(
    detail?.result ?? "",
    calls.map((c) => c.result),
    detail?.instruction ?? "",
    calls.filter((c) => TEXT_AMOUNT_TOOLS.has(c.toolName)).map((c) => c.result),
  );
  const amountPending = amounts.untraced.filter((u) => !acked.has(amountKey(u))).length;
  // 与任务页、台账同一口径：待确认金额按「为什么找不到出处」分两类，检索结果池不按 ok 过滤
  const amountSplitLocal = classifyUntraced(
    amounts.untraced.filter((u) => !acked.has(amountKey(u))),
    calls.filter((c) => SEARCH_TOOL_NAMES.has(c.toolName)).map((c) => c.result),
  );
  const rc = reviewCounts(extractIssues(t.id), listReviews(t.id));
  const refRecs = listRefChecks(t.id);
  const refs = traceDocRefs(
    detail?.result ?? "",
    calls.filter((c) => c.ok !== false).map((c) => c.result),
    calls.map((c) => c.toolName),
    // 复查判定「找到公开出处」的文号同样算有出处，与看板、结果页、证据表同一口径
    refRecs.filter((r) => r.kind === "docref" && r.verdict === "matched").map((r) => r.text),
  );
  const toolOk = calls.filter((c) => c.ok === true).length;
  const toolFailed = calls.filter((c) => c.ok === false).length;
  // 链接核验：与结果页同一份数据、同一道过滤（link-check.ts 的 liveLinkChecks）。
  // 此前本脚本从头到尾没读过 link_checks：manifest 的 linkCheck 一节写死 null、每条引用的 verdict
  // 写死 "unchecked"，于是 manifestIssues 里那两条链接规则只在合成数据上跑过，而交付自检的
  // warns/infos 与产品真实产出差了 6 个任务（实测）。
  const lcRows = listLinkChecks(t.id);
  const cites = citationsOf(
    calls,
    detail?.result ?? "",
    new Map(lcRows.map((r) => [r.url, r] as [string, LinkCheckLike])),
  );
  const lcLive = liveLinkChecks(lcRows, cites.map((c) => c.url));
  const lcSum = summarizeLinkChecks(lcLive);
  // 核验时间取全量行的最大值，与服务端 GET /link-checks 同一口径
  const lcAt = lcRows.reduce((m, r) => (r.checkedAt && r.checkedAt > m ? r.checkedAt : m), "") || null;
  if (lcRows.length > 0) {
    linkTasks += 1;
    linkRowsTotal += lcRows.length;
    linkStaleTotal += lcRows.length - lcLive.length;
  }
  // 清单内部两处独立组装的数字必须对上：带核验结论的引用条数 == 链接核验汇总的总数
  const withVerdict = cites.filter((c) => c.verdict !== "unchecked").length;
  citesWithVerdict += withVerdict;
  checks += 1;
  if (withVerdict !== lcSum.total) {
    failures.push(`${t.id.slice(0, 8)} 清单里带核验结论的引用 ${withVerdict} 条 ≠ 链接核验汇总总数 ${lcSum.total}`);
  }
  // 与 stats.ts 同一口径：weakUncited 是「未进结论正文」再扣掉「已声明为背景参考」的那部分
  const disclaimedLocal = disclaimedWeakUrls(cites, detail?.result ?? "");
  const uncitedLocal = uncitedWeakItems(cites, detail?.result ?? "").filter((i) => !disclaimedLocal.has(i.url));
  const grades = summarizeGrades(cites);
  const searches = searchEvidence(calls);
  const refSum = summarizeRefChecks(refRecs.filter((r) => r.kind === "docref"));
  const citeCheckSum = summarizeRefChecks(refRecs.filter((r) => r.kind === "citation"));
  // 修订影响：结论按运行重组后取最后两轮对比（与结果页同一口径）
  const conclusions = listConclusions(t.id);
  const rev =
    conclusions.length >= 2
      ? (() => {
          const before = evidenceSnapshot(conclusions[conclusions.length - 2]!);
          const after = evidenceSnapshot(conclusions[conclusions.length - 1]!);
          const delta = evidenceDelta(before, after);
          return { before, after, delta, verdict: deltaVerdict(delta) };
        })()
      : null;
  checks += 1;
  if (rev && rev.verdict !== deltaVerdict(evidenceDelta(rev.before, rev.after))) {
    failures.push(`${t.id.slice(0, 8)} 修订影响判断与前后快照不符`);
  }
  const refPending = refs.untraced.length + refs.unverifiable;
  checks += 1;
  if (refSum.total !== refSum.matched + refSum.candidate + refSum.empty + refSum.error) {
    failures.push(`${t.id.slice(0, 8)} 文号复查四类之和不等于总数`);
  }
  // 复查取得的出处已计入 traced，两个数不能再各扣一遍：恒等式一破就说明口径又岔开了
  checks += 1;
  if (refs.traced + refPending !== refs.total) {
    failures.push(`${t.id.slice(0, 8)} 文号有出处 ${refs.traced} + 待复查 ${refPending} ≠ 总数 ${refs.total}`);
  }
  checks += 1;
  if (refs.tracedByRecheck > refs.traced) {
    failures.push(`${t.id.slice(0, 8)} 复查取得的出处 ${refs.tracedByRecheck} 超过有出处总数 ${refs.traced}`);
  }
  for (const rec of refRecs) {
    checks += 1;
    // 文号按文本算主键，引用按原地址算主键：两种都要能从落库字段自校验回来
    const want = rec.kind === "citation" ? `citation:${normalizeRef(rec.subjectUrl)}` : `docref:${normalizeRef(rec.text)}`;
    if (rec.key !== want) {
      failures.push(`${t.id.slice(0, 8)} 复查记录主键不符：${rec.key} ≠ ${want}`);
    }
    checks += 1;
    if (rec.kind === "citation" && !/^https?:\/\//.test(rec.subjectUrl)) {
      failures.push(`${t.id.slice(0, 8)} 引用类复查记录缺少原地址：${rec.key}`);
    }
  }
  checks += 1;
  if (searches.calls !== searches.withUrls + searches.metadataOnly) {
    failures.push(`${t.id.slice(0, 8)} 检索留痕两类之和 ${searches.withUrls + searches.metadataOnly} ≠ 调用数 ${searches.calls}`);
  }
  // 结论正文里的地址也算引用，因此只有工具留存的引用才要求存在留下来源的检索调用
  if (searches.withUrls === 0 && cites.some((c) => c.via !== "conclusion")) {
    failures.push(`${t.id.slice(0, 8)} 有工具留存的引用却没有留下来源的检索调用`);
  }
  gradeTotals.total += grades.total;
  gradeTotals.official += grades.official;
  gradeTotals.professional += grades.professional;
  gradeTotals.weak += grades.weak;
  if (grades.total > 0) tasksWithCitations += 1;
  const input: ManifestInput = {
    task: {
      id: t.id,
      title: t.title,
      caseId: t.caseId,
      agentId: t.agentId,
      status: t.status,
      createdAt: t.createdAt,
      runCount: wins.length,
    },
    delivery: deliveryCheck({
      status: t.status,
      resultChars: (detail?.result ?? "").trim().length,
      artifacts: artNames.length,
      unattributedArtifacts: artNames.filter((n) => !src.has(n)).length,
      toolTotal: calls.length,
      toolFailed,
      toolRunning: calls.filter((c) => c.ok === null).length,
      pendingReview: pendingReviewIssues(t.id).length,
      citations: cites.length,
      citationGrades: cites.length > 0 ? grades : null,
      offTopicCitations: offTopicCitationTitles(cites, detail?.result ?? ""),
      searches: searches.calls > 0 ? searches : null,
      linkCheck: lcAt ? lcSum : null,
      linkCheckAgeHours: ageHours(lcAt),
      amountTotal: amounts.total,
      amountUntraced: amountPending,
      amountPendingWeb: amountSplitLocal.web.length,
      amountPendingUnexplained: amountSplitLocal.unexplained.length,
      filesTotal: listFiles(t.id).length,
      filesFailed: listFiles(t.id).filter((f) => f.parseStatus === "failed").length,
      docRefTotal: refs.total,
      docRefTraced: refs.traced,
      docRefUnverifiable: refs.unverifiable,
      docRefUntraced: refs.untraced.length,
      docRefRecheck: refSum.total > 0 ? refSum : null,
      docRefPending: refPending,
      citationRecheck: citeCheckSum.total > 0 ? citeCheckSum : null,
      revision: rev
        ? {
            citations: rev.delta.citations,
            official: rev.delta.official,
            weak: rev.delta.weak,
            docRefs: rev.delta.docRefs,
            improved: rev.delta.improved,
            regressed: rev.delta.regressed,
          }
        : null,
    }),
    files: listFiles(t.id).map((f) => ({
      name: f.fileName,
      type: f.fileType,
      byteSize: f.byteSize,
      uploadedAt: f.createdAt,
      parseStatus: f.parseStatus,
      parseDetail: parseDetail(parsed.get(f.fileName)),
    })),
    artifacts: artNames.map((n) => {
      const s = src.get(n);
      const stat = fs.statSync(path.join(dir, n));
      const art = { name: n, byteSize: stat.size, updatedAt: stat.mtime.toISOString() };
      const win = wins.find((w) => artifactsOfRun([{ ...art }], w).length > 0);
      return {
        ...art,
        sourceTool: s?.toolName ?? null,
        sourceRole: s ? s.role : null,
        sourceAt: s?.at ?? null,
        run: win ? win.run : null,
      };
    }),
    tools: {
      total: calls.length,
      ok: toolOk,
      failed: toolFailed,
      running: calls.filter((c) => c.ok === null).length,
      avgMs: null,
    },
    citations: cites,
    citationGrades: cites.length > 0 ? grades : null,
    searches: searches.calls > 0 ? searches : null,
    refChecks: refSum.total > 0 ? refSum : null,
    citationChecks: citeCheckSum.total > 0 ? citeCheckSum : null,
    revision: rev ? { before: rev.before, after: rev.after, verdict: rev.verdict } : null,
    linkCheck: { summary: lcAt ? lcSum : null, checkedAt: lcAt },
    amounts: {
      total: amounts.total,
      traced: amounts.traced,
      fromInput: amounts.fromInput,
      pending: amountPending,
      acked: amounts.untraced.length - amountPending,
      pendingWeb: amountSplitLocal.web.length,
      pendingUnexplained: amountSplitLocal.unexplained.length,
    },
    review: { issues: rc.total, done: rc.done, pending: rc.pending, notRequired: rc.notRequired },
    generatedAt: "2026-09-28T12:00:00.000Z",
  };
  const builtManifest = buildManifest(input);
  if (builtManifest.linkCheck.summary) manifestLinkSummaries += 1;
  const issues = manifestIssues(builtManifest);
  built += 1;
  if (issues.length > 0) failures.push(`${t.id.slice(0, 8)} 清单不自洽：${issues.join("；")}`);

  // ---- 交叉核对之一：任务级，台账行（服务端聚合）vs 本次组装（前端交付路径）----
  const row = rowByTask.get(t.id);
  checks += 1;
  if (!row) failures.push(`${t.id.slice(0, 8)} 台账里没有这个任务的行，看板与交付包对不上`);
  if (row) {
    rowsCompared += 1;
    const pairs: Array<[string, number, number]> = [
      ["文号总数", row.docRefTotal, refs.total],
      ["文号有出处", row.docRefTraced, refs.traced],
      ["其中仅正文提到", row.docRefTracedByBody, refs.tracedByBody],
      ["其中复查取得", row.docRefTracedByRecheck, refs.tracedByRecheck],
      ["待复查文号", row.docRefPending, refPending],
      ["复查判定 matched", row.docRefMatched, refSum.matched],
      ["检索调用", row.searchCalls, searches.calls],
      ["仅元数据检索", row.searchMetadataOnly, searches.metadataOnly],
      ["金额总数", row.amountTotal, amounts.total],
      ["金额待确认", row.amountPending, amountPending],
      ["其中引自联网正文", row.amountPendingWeb, amountSplitLocal.web.length],
      ["其中三处均无出处", row.amountPendingUnexplained, amountSplitLocal.unexplained.length],
    ];
    for (const [label, ledgerSide, deliverySide] of pairs) {
      checks += 1;
      pairChecks += 1;
      if (ledgerSide !== deliverySide) {
        failures.push(`${t.id.slice(0, 8)} ${label}：台账 ${ledgerSide} ≠ 交付包 ${deliverySide}`);
      }
    }
    // 引用这一族要单独走：台账与看板侧的口径是「没有结论的任务不计引用」（stats.ts 里明写，
    // 理由是无结论任务的引用进不了缺口清单，计进来会让台账欠账与缺口清单互相矛盾）。
    // 弱证据的两类「不必再催办」同理——它们都要回读结论正文才判得出来（分级只看地址与标题），
    // 没有结论就没有正文可回读，stats.ts 对这两项也一律记 0。
    // 交叉核对必须把这条口径显式复现并断言：既不能当成不一致报失败（那是口径差异不是缺陷），
    // 也不能一声不响地跳过（跳过就等于这条口径从此没人守，哪天被改回去也没人发现）。
    const hasConclusion = (detail?.result ?? "").trim() !== "";
    if (hasConclusion) {
      conclusionRows += 1;
      const conclusionPairs: Array<[string, number, number]> = [
        ["引用总数", row.citations, cites.length],
        ["官方来源", row.official, grades.official],
        ["证据力弱", row.weak, grades.weak],
        ["已声明背景参考的弱证据", row.weakDisclaimed, disclaimedLocal.size],
        ["未进结论正文的弱证据", row.weakUncited, uncitedLocal.length],
      ];
      for (const [label, ledgerSide, deliverySide] of conclusionPairs) {
        checks += 1;
        pairChecks += 1;
        if (ledgerSide !== deliverySide) {
          failures.push(`${t.id.slice(0, 8)} ${label}：台账 ${ledgerSide} ≠ 交付包 ${deliverySide}`);
        }
      }
      cross.citations += cites.length;
      cross.official += grades.official;
      cross.weak += grades.weak;
    } else {
      skippedTasks += 1;
      skippedCites += cites.length;
      for (const [label, ledgerSide] of [
        ["引用总数", row.citations],
        ["官方来源", row.official],
        ["证据力弱", row.weak],
        ["已声明背景参考的弱证据", row.weakDisclaimed],
        ["未进结论正文的弱证据", row.weakUncited],
      ] as Array<[string, number]>) {
        checks += 1;
        pairChecks += 1;
        if (ledgerSide !== 0) {
          failures.push(
            `${t.id.slice(0, 8)} 无结论任务的台账${label}应为 0（口径：没有结论就不计引用、也判不出弱证据是否进过正文），实际 ${ledgerSide}`,
          );
        }
      }
    }
    cross.docRefTotal += refs.total;
    cross.docRefTraced += refs.traced;
    cross.docRefTracedByBody += refs.tracedByBody;
    cross.docRefTracedByRecheck += refs.tracedByRecheck;
    cross.docRefPending += refPending;
    cross.docRefMatched += refSum.matched;
    cross.searchCalls += searches.calls;
    cross.searchMetadataOnly += searches.metadataOnly;
    cross.amountTotal += amounts.total;
    cross.amountPending += amountPending;
    cross.amountPendingWeb += amountSplitLocal.web.length;
    cross.amountPendingUnexplained += amountSplitLocal.unexplained.length;
  }

  // ---- 交付 MD 的金额节：人读那一行里的数字与表里每行的类别都要对得上 ----
  // 取数直接复用上面已经算好的 amounts / amountSplitLocal，不再抄第三份 SQL
  cross.mdAmountChecked += 1;
  const amountMd = amountSection({
    total: amounts.total,
    traced: amounts.traced,
    fromInput: amounts.fromInput,
    pending: amounts.untraced.filter((u) => !acked.has(amountKey(u))),
    split: amountSplitLocal,
    ackedCount: amounts.untraced.length - amountPending,
    acked: amounts.untraced
      .filter((u) => acked.has(amountKey(u)))
      .map((u) => {
        const rec = ackRows.find((r) => r.key === amountKey(u));
        return { raw: u.raw, occurrences: 1, at: rec?.createdAt ?? "", note: rec?.note ?? "" };
      }),
  });
  const amountHead = amountMd.find((l) => l.startsWith("- 结论中识别出金额")) ?? "";
  for (const frag of [
    `金额 ${amounts.total} 处`,
    `可溯源 ${amounts.traced} 处`,
    `来自客户指令 ${amounts.fromInput} 处`,
    `待人工确认 ${amountPending} 处`,
  ]) {
    checks += 1;
    if (!amountHead.includes(frag)) {
      failures.push(`${t.id.slice(0, 8)} 交付 MD 的金额节没写出「${frag}」，实际是：${amountHead.slice(0, 90)}`);
    }
  }
  if (amountPending > 0) {
    for (const frag of [
      `引自联网正文 ${amountSplitLocal.web.length} 处`,
      `三处均无出处 ${amountSplitLocal.unexplained.length} 处`,
    ]) {
      checks += 1;
      if (!amountHead.includes(frag)) {
        failures.push(`${t.id.slice(0, 8)} 交付 MD 的金额节没写出「${frag}」`);
      }
    }
    const amtHeader = "| # | 金额 | 结论中的上下文 | 类别 | 处理建议 |";
    const at = amountMd.indexOf(amtHeader);
    checks += 1;
    if (at < 0) failures.push(`${t.id.slice(0, 8)} 交付 MD 的金额节缺待确认表`);
    let amtRows = 0;
    for (let i = at + 2; i < amountMd.length && (amountMd[i] ?? "").startsWith("|"); i++) amtRows += 1;
    const wantRows = Math.min(amountPending, AMOUNT_TABLE_LIMIT);
    checks += 1;
    if (at >= 0 && amtRows !== wantRows) {
      failures.push(`${t.id.slice(0, 8)} 交付 MD 金额表 ${amtRows} 行 ≠ ${wantRows} 行`);
    }
    for (let i = at + 2; i < at + 2 + amtRows; i++) {
      checks += 1;
      const line = amountMd[i] ?? "";
      if (!line.includes(UNTRACED_ORIGIN_TEXT.web) && !line.includes(UNTRACED_ORIGIN_TEXT.unexplained)) {
        failures.push(`${t.id.slice(0, 8)} 金额表有一行没标类别：${line.slice(0, 40)}`);
      }
    }
  }

  // ---- 交叉核对之二：交付 MD 的文号节，人读那一行里的数字必须与结构化数据一致 ----
  cross.mdChecked += 1;
  const mdHead =
    docRefSection({ refTrace: refs, refSummary: refSum, refChecks: refRecs }).find((l) =>
      l.startsWith("- 结论中出现政策文号"),
    ) ?? "";
  for (const frag of [
    `政策文号 ${refs.total} 处`,
    `有公开出处 ${refs.traced} 处`,
    `联网复查取得 ${refs.tracedByRecheck} 处`,
    `仅留存正文提到 ${refs.tracedByBody} 处`,
    `无法从留存数据核验 ${refs.unverifiable} 处`,
    `待人工确认 ${refs.untraced.length} 处`,
  ]) {
    checks += 1;
    if (!mdHead.includes(frag)) {
      failures.push(`${t.id.slice(0, 8)} 交付 MD 的文号节没写出「${frag}」，实际是：${mdHead.slice(0, 90)}`);
    }
  }
}

// ---- 交叉核对之三：平台级，看板聚合 vs 交付路径逐任务累加 ----
const platPairs: Array<[string, number, number]> = [
  ["文号总数", platform.docRefs, cross.docRefTotal],
  ["文号有出处", platform.docRefTraced, cross.docRefTraced],
  ["其中仅正文提到", platform.docRefTracedByBody, cross.docRefTracedByBody],
  ["其中复查取得", platform.docRefTracedByRecheck, cross.docRefTracedByRecheck],
  ["待复查文号", platform.docRefPending, cross.docRefPending],
  ["复查判定 matched", platform.docRefMatched, cross.docRefMatched],
  ["引用总数", platform.citations, cross.citations],
  ["官方来源", platform.officialCitations, cross.official],
  ["证据力弱", platform.weakCitations, cross.weak],
  ["检索调用", platform.searchCalls, cross.searchCalls],
  ["仅元数据检索", platform.searchMetadataOnly, cross.searchMetadataOnly],
  // 金额这一族此前只有任务级对比，平台级没法比——因为 evidence 里根本没有金额聚合。
  // 补上之后这里逐项对，作品说明里那句「全平台 N 处结论金额」也才有取数来源。
  ["金额总数", platform.amountTotal, cross.amountTotal],
  ["金额待确认", platform.amountPending, cross.amountPending],
  ["其中引自联网正文", platform.amountPendingWeb, cross.amountPendingWeb],
  ["其中三处均无出处", platform.amountPendingUnexplained, cross.amountPendingUnexplained],
];
for (const [label, boardSide, deliverySide] of platPairs) {
  checks += 1;
  if (boardSide !== deliverySide) {
    failures.push(`平台级 ${label}：看板 ${boardSide} ≠ 交付包逐任务累加 ${deliverySide}`);
  }
}
// 走查型断言必须同时断「确实检查到了东西」：一个任务都没比到、或一行 MD 都没核到，都是空跑
checks += 1;
if (rowsCompared < 1) failures.push("一个任务的台账行都没比对到，任务级交叉核对等于空跑");
checks += 1;
if (conclusionRows < 1) failures.push("一个有结论的任务都没比对到，引用族的交叉核对等于空跑");
checks += 1;
if (cross.mdChecked < 1) failures.push("交付 MD 的文号节一处都没核对到");
checks += 1;
if (cross.mdAmountChecked < 1) failures.push("交付 MD 的金额节一处都没核对到");
checks += 1;
if (linkTasks < 1) failures.push("一个带链接核验记录的真实任务都没走到，manifest 的链接核验一节等于没验");
checks += 1;
if (citesWithVerdict < 1) failures.push("真实数据里一条带核验结论的引用都没有，verdict 这一列等于没验");
checks += 1;
// 光「读到了核验行」还不够：得真的组装进 manifest，否则 manifestIssues 里那两条链接规则
// （四类之和、条数不多于引用数）会因为 summary 是 null 而整段跳过，绿得毫无意义。
if (manifestLinkSummaries < 1) failures.push("没有一个真实任务的 manifest 带上了链接核验汇总，这一节的自校验等于没跑");
checks += 1;
if (manifestLinkSummaries !== linkTasks) {
  failures.push(`manifest 带链接核验汇总的任务 ${manifestLinkSummaries} 个 ≠ 库里有核验记录的任务 ${linkTasks} 个`);
}
if (cross.docRefTotal < 1 && cross.citations < 1) {
  failures.push("交叉核对的指标全是 0，比了等于没比（库里没有真实数据？）");
}
console.log(
  `[verify] 交叉核对：任务级 ${rowsCompared} 个任务 · 逐项对比 ${pairChecks} 次（其中有结论 ${conclusionRows} 个）· 交付 MD 文号节 ${
    cross.mdChecked
  } 个 × 6 项 · 金额节 ${cross.mdAmountChecked} 个 · 平台级 ${platPairs.length} 项（金额待确认合计 ${
    cross.amountPending
  } / 总额 ${cross.amountTotal}）`,
);
console.log(
  `[verify] 链接核验走查：${linkTasks} 个任务共 ${linkRowsTotal} 行（陈旧 ${linkStaleTotal} 行不计入）· 带核验结论的引用 ${citesWithVerdict} 条`,
);
if (skippedTasks > 0) {
  console.log(
    `[verify] 口径差异（有意为之，已断言）：${skippedTasks} 个无结论任务的台账引用记 0，其交付包侧另有 ${skippedCites} 条检索留存引用不计入看板`,
  );
}

console.log(
  `[verify] 清单检查项=${checks} 真实任务=${built} 失败=${failures.length} · 引用分级：${tasksWithCitations} 个任务共 ${gradeTotals.total} 条（官方 ${gradeTotals.official} · 专业 ${gradeTotals.professional} · 证据力弱 ${gradeTotals.weak}）`,
);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 交付清单不自洽");
  process.exit(1);
}
console.log("[PASS] 交付清单结构与自校验正确（含全部真实任务走查）");
