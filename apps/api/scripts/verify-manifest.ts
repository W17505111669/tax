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
import { traceAmounts, amountKey } from "../../web/src/amount-trace.ts";
import { parseDetail, parsedByFileName } from "../../web/src/file-parse.ts";
import { reviewCounts } from "../../web/src/review-export.ts";
import { normalizeRef, traceDocRefs } from "../../web/src/policy-trace.ts";
import { gradeCitation, summarizeGrades } from "../../web/src/citation-grade.ts";
import {
  extractCitations,
  extractTextCitations,
  mergeCitations,
  searchEvidence,
} from "../../web/src/search-evidence.ts";
import { offTopicCitationTitles, summarizeRefChecks } from "../../web/src/ref-check.ts";
import { deltaVerdict, evidenceDelta, evidenceSnapshot } from "../../web/src/revision-impact.ts";
import { db } from "../src/db.ts";
import { dirs } from "../src/config.ts";
import { listAmountChecks } from "../src/services/amount-checks.ts";
import { listRefChecks } from "../src/services/ref-checks.ts";
import { extractIssues, listReviews, pendingReviewIssues } from "../src/services/issues.ts";
import { getTask, listConclusions, listFiles, listTasks } from "../src/services/task-store.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

type ManifestCitation = ManifestInput["citations"][number];

/** 与前端同一口径：引用提取走 search-evidence.ts（工具留存 + 结论正文），验证脚本不另写一套 */
function citationsOf(calls: Array<{ toolName: string; result: unknown }>, result: string): ManifestCitation[] {
  return mergeCitations(extractCitations(calls), extractTextCitations(result)).map((c) => {
    const g = gradeCitation(c.url, c.title);
    return {
      title: c.title,
      url: c.url,
      verdict: "unchecked",
      status: null,
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
    before: { citations: 3, official: 1, professional: 1, weak: 1, docRefs: 2 },
    after: { citations: 3, official: 2, professional: 1, weak: 0, docRefs: 2 },
    verdict: "证据质量改善",
  },
  amounts: { total: 10, traced: 8, fromInput: 1, pending: 1, acked: 0 },
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
  const acked = new Set(listAmountChecks(t.id).map((c) => c.key));
  const amounts = traceAmounts(detail?.result ?? "", calls.map((c) => c.result), detail?.instruction ?? "");
  const amountPending = amounts.untraced.filter((u) => !acked.has(amountKey(u))).length;
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
  const cites = citationsOf(calls, detail?.result ?? "");
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
      linkCheck: null,
      linkCheckAgeHours: null,
      amountTotal: amounts.total,
      amountUntraced: amountPending,
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
    linkCheck: { summary: null, checkedAt: null },
    amounts: {
      total: amounts.total,
      traced: amounts.traced,
      fromInput: amounts.fromInput,
      pending: amountPending,
      acked: amounts.untraced.length - amountPending,
    },
    review: { issues: rc.total, done: rc.done, pending: rc.pending, notRequired: rc.notRequired },
    generatedAt: "2026-09-28T12:00:00.000Z",
  };
  const issues = manifestIssues(buildManifest(input));
  built += 1;
  if (issues.length > 0) failures.push(`${t.id.slice(0, 8)} 清单不自洽：${issues.join("；")}`);
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
