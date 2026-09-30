/**
 * 验证脚本：人工复核状态一致性。
 * 检查项：needsReopenReview 真值表；waiting_review 任务必须仍有待复核问题；
 * 统计「已完成但仍有待复核问题」的任务数（前端在复核页给出「转为待复核」补救入口）。
 * 运行：pnpm verify:review
 */
import {
  extractIssues,
  needsReopenReview,
  pendingReviewCount,
  pendingReviewIssues,
  selectReopenTargets,
} from "../src/services/issues.ts";
import { getTask, listTasks } from "../src/services/task-store.ts";
import { computePlatformStats } from "../src/services/stats.ts";
import { buildDerivedFrom, isTemplateCompare } from "../src/services/compare-stats.ts";
import { groupPendingIssues, groupSummary } from "../../web/src/review-queue.ts";
import { db } from "../src/db.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

// 1) 一致性判定真值表
expect("完成 + 有待复核 → 需重开", needsReopenReview("completed", 3), true);
expect("完成 + 无待复核 → 不需重开", needsReopenReview("completed", 0), false);
expect("待复核 + 有待复核 → 不需重开", needsReopenReview("waiting_review", 3), false);
expect("待复核 + 无待复核 → 不需重开", needsReopenReview("waiting_review", 0), false);
expect("执行中 + 有待复核 → 不需重开", needsReopenReview("processing", 3), false);
expect("失败 + 有待复核 → 不需重开", needsReopenReview("failed", 3), false);

// 2) 真实数据：waiting_review 必须仍有待复核问题（全部复核完应自动流转 completed）
const tasks = listTasks();
let waiting = 0;
let reopenable = 0;
let reopenableListed = 0;
let totalPending = 0;
for (const t of tasks) {
  checks += 2;
  const pending = pendingReviewIssues(t.id).length;
  totalPending += pending;
  if (t.status === "waiting_review") {
    waiting += 1;
    if (pending === 0) failures.push(`${t.id} 状态为 waiting_review 但待复核为 0`);
  }
  if (needsReopenReview(t.status, pending)) reopenable += 1;
  if (needsReopenReview(t.status, t.reviewPending ?? 0)) reopenableListed += 1;

  // 列表接口附带的计数走缓存，口径必须与实时提取一致（第二次调用覆盖缓存命中路径）
  if (typeof t.reviewPending !== "number") {
    failures.push(`${t.id} 列表接口缺少 reviewPending`);
  } else if (t.reviewPending !== pending) {
    failures.push(`${t.id} 列表 reviewPending=${t.reviewPending} 与实时提取 ${pending} 不一致`);
  }
  const first = pendingReviewCount(t.id);
  const second = pendingReviewCount(t.id);
  if (first !== pending || second !== pending) {
    failures.push(`${t.id} pendingReviewCount=${first}/${second} 与实时提取 ${pending} 不一致`);
  }
}
expect("列表口径与逐项计算的可重开任务数一致", reopenableListed, reopenable);

// 3) 平台统计（概览页复核闭环缺口卡）口径必须与逐项计算一致
const stats = computePlatformStats();
expect("平台待复核问题合计一致", stats.reviewPendingIssues, totalPending);
expect("平台复核缺口任务数一致", stats.reviewBacklog.length, reopenable);
expect(
  "缺口清单的未复核项合计不超过全平台合计",
  stats.reviewBacklog.reduce((s, b) => s + b.pending, 0) <= stats.reviewPendingIssues,
  true,
);
expect(
  "平台缺口清单均为完成态且有未复核问题",
  stats.reviewBacklog.every((b) => b.pending > 0 && tasks.some((t) => t.id === b.id && t.status === "completed")),
  true,
);

// 4) 批量重开复核的目标筛选
expect(
  "批量筛选-只挑完成态且有未复核问题",
  selectReopenTargets([
    { id: "a", status: "completed", pending: 2 },
    { id: "b", status: "completed", pending: 0 },
    { id: "c", status: "waiting_review", pending: 3 },
    { id: "d", status: "processing", pending: 1 },
    { id: "e", status: "failed", pending: 4 },
  ]),
  ["a"],
);
expect("批量筛选-空输入", selectReopenTargets([]), []);
expect(
  "批量筛选-全平台口径与缺口清单一致",
  selectReopenTargets(tasks.map((t) => ({ id: t.id, status: t.status, pending: pendingReviewCount(t.id) }))).length,
  stats.reviewBacklog.length,
);

// 待复核清单只列「当前还需要人看」的项。两条过滤都得有断言盯着，否则清单会重新长回一百多条：
// 实测改之前 135 条里有 43 条来自一个 failed 任务（没有结论，那次运行的差异是残渣）、
// 15 条来自「与自己的原始模板比对」（只有一侧有的格子正是填进去的值，不是问题）、
// 其余多是同一任务反复比对时早先那一次留下的、已经被后来那次取代的差异
let noConclusionViolations = 0;
let staleCompareIssues = 0;
let compareIssues = 0;
// 全量重算型工具（返回完整 issues 清单的那批）只认最近一次成功调用：同一任务重跑后，旧一轮
// 描述的状态已不存在（实测 09046f0a 续跑后「HT-001 建安工程合同 / 1 张发票」与新一轮
// 「HT-001 总承包合同 / 2 张发票」并存，同一件事两条，去重键因为描述里带合同名而拦不住）
let staleIssuesFromOldRun = 0;
let issuesToolCalls = 0;
for (const t of tasks) {
  const issues = extractIssues(t.id);
  const hasConclusion = String(getTask(t.id)?.result ?? "").trim() !== "";
  if (!hasConclusion && issues.length > 0) noConclusionViolations += issues.length;
  const rows = db
    .prepare(
      `SELECT id, tool_name, args, result FROM tool_calls
        WHERE task_id = ? AND ok = 1 AND result IS NOT NULL ORDER BY started_at ASC`,
    )
    .all(t.id) as unknown as Array<{ id: string; tool_name: string; args: string | null; result: string | null }>;
  const derived = buildDerivedFrom(rows);
  const peers = rows.filter((c) => c.tool_name === "compare_workpapers" && !isTemplateCompare(c.args, derived));
  const latestId = peers.length > 0 ? peers[peers.length - 1]!.id : null;
  const latestIssuesCall = new Map<string, string>();
  for (const c of rows) {
    try {
      if (Array.isArray((JSON.parse(c.result ?? "null") as { issues?: unknown } | null)?.issues)) {
        latestIssuesCall.set(c.tool_name, c.id);
      }
    } catch {
      // 结果不是合法 JSON 的调用不参与「最近一次」判定
    }
  }
  for (const i of issues) {
    const latest = latestIssuesCall.get(i.source);
    if (latest !== undefined) {
      issuesToolCalls += 1;
      if (i.id.split(":")[0] !== latest) staleIssuesFromOldRun += 1;
    }
    if (i.source !== "compare_workpapers") continue;
    compareIssues += 1;
    if (i.id.split(":")[0] !== latestId) staleCompareIssues += 1;
  }
}
expect("没有结论的任务不列待复核问题", noConclusionViolations, 0);
expect("比对类问题只来自最近一次与人工底稿的比对", staleCompareIssues, 0);
expect("全量重算型工具的问题只来自同名工具最近一次调用", staleIssuesFromOldRun, 0);
expect("确实检查到了全量重算型工具的问题（否则上一条断言是空跑）", issuesToolCalls > 0, true);

// 跨任务分组：同一件事在多个任务里各出现一次时，看板上一次处置（实测 58 条里有 7 类跨任务重复，
// 「研发人员名单尚未取得」一类就在 6 个任务里各出现一次）
const flat = stats.reviewGroups.flatMap((g) => g.items);
expect("分组后条数与待复核合计一致", flat.length, stats.reviewPendingIssues);
expect(
  "每组内类型与描述一致",
  stats.reviewGroups.every((g) => g.items.every((i) => i.issueType === g.issueType && i.description === g.description)),
  true,
);
expect(
  "组间按出现次数倒序",
  stats.reviewGroups.every((g, i) => i === 0 || stats.reviewGroups[i - 1]!.items.length >= g.items.length),
  true,
);
expect(
  "同一任务的同一条问题不重复计入",
  new Set(flat.map((i) => `${i.taskId}|${i.issueId}`)).size,
  flat.length,
);
const grouped = groupPendingIssues([
  { taskId: "b", taskTitle: "B任务", agentId: "rd-audit", issueId: "b1", issueType: "资料缺失", description: "研发人员名单尚未取得" },
  { taskId: "a", taskTitle: "A任务", agentId: "rd-audit", issueId: "a1", issueType: "资料缺失", description: "研发人员名单尚未取得" },
  { taskId: "c", taskTitle: "C任务", agentId: "land-vat", issueId: "c1", issueType: "金额差异", description: "合同 HT-001 差异 100000.00 元" },
]);
expect("同一事实跨任务合并为一组", grouped.length, 2);
expect("出现次数多的组排在前，组内按任务标题排序", grouped[0]?.items.map((i) => i.taskId), ["a", "b"]);
expect("分组汇总", groupSummary(grouped), { items: 3, groups: 2, recurringGroups: 1, recurringItems: 2 });
expect("空清单不报错", groupSummary(groupPendingIssues([])), {
  items: 0,
  groups: 0,
  recurringGroups: 0,
  recurringItems: 0,
});
console.log(
  `[verify] 任务数=${tasks.length} 待复核态=${waiting} 完成但仍需重开复核=${reopenable} 待复核问题合计=${totalPending}`,
);
console.log(`[verify] 其中比对类问题 ${compareIssues} 条（均来自各任务最近一次与人工底稿的比对）`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 复核状态一致性检查失败");
  process.exit(1);
}
console.log("[PASS] 复核状态一致性规则正确（完成态遗留问题由前端提示「转为待复核」处理）");
