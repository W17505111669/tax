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
import { traceDocRefs } from "../../web/src/policy-trace.ts";
import { db } from "../src/db.ts";
import { dirs } from "../src/config.ts";
import { listAmountChecks } from "../src/services/amount-checks.ts";
import { extractIssues, listReviews, pendingReviewIssues } from "../src/services/issues.ts";
import { getTask, listFiles, listTasks } from "../src/services/task-store.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
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
    { title: "政策", url: "https://x.gov.cn/a", verdict: "ok", status: 200 },
    { title: "案例", url: "https://y.cn/b", verdict: "blocked", status: 403 },
  ],
  linkCheck: {
    summary: { total: 2, ok: 1, blocked: 1, dead: 0, unreachable: 0 },
    checkedAt: "2026-09-28T03:00:00.000Z",
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

// 真实任务走查：用数据库与产物目录组装清单，必须自洽
let built = 0;
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
  const refs = traceDocRefs(
    detail?.result ?? "",
    calls.filter((c) => c.ok !== false).map((c) => c.result),
    calls.map((c) => c.toolName),
  );
  const toolOk = calls.filter((c) => c.ok === true).length;
  const toolFailed = calls.filter((c) => c.ok === false).length;
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
      citations: 0,
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
    citations: [],
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

console.log(`[verify] 清单检查项=${checks} 真实任务=${built} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 交付清单不自洽");
  process.exit(1);
}
console.log("[PASS] 交付清单结构与自校验正确（含全部真实任务走查）");
