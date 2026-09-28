/**
 * 验证脚本：人工复核状态一致性。
 * 检查项：needsReopenReview 真值表；waiting_review 任务必须仍有待复核问题；
 * 统计「已完成但仍有待复核问题」的任务数（前端在复核页给出「转为待复核」补救入口）。
 * 运行：pnpm verify:review
 */
import {
  needsReopenReview,
  pendingReviewCount,
  pendingReviewIssues,
  selectReopenTargets,
} from "../src/services/issues.ts";
import { listTasks } from "../src/services/task-store.ts";
import { computePlatformStats } from "../src/services/stats.ts";

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

console.log(
  `[verify] 任务数=${tasks.length} 待复核态=${waiting} 完成但仍需重开复核=${reopenable} 待复核问题合计=${totalPending}`,
);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 复核状态一致性检查失败");
  process.exit(1);
}
console.log("[PASS] 复核状态一致性规则正确（完成态遗留问题由前端提示「转为待复核」处理）");
