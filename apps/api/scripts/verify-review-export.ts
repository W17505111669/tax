/**
 * 验证脚本：人工复核记录的交付导出。
 * 除了格式与转义，重点校验「待复核」计数与后端 pendingReviewIssues 在全部真实任务上完全一致。
 * 运行：pnpm verify:revexp
 */
import { DECISION_TEXT, reviewCounts, reviewSection, type IssueLike, type ReviewLike } from "../../web/src/review-export.ts";
import { extractIssues, listReviews, pendingReviewIssues } from "../src/services/issues.ts";
import { listTasks } from "../src/services/task-store.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

// 1) 计数与分节
const issues: IssueLike[] = [
  { id: "i1", source: "check_rd_expenses", issueType: "账账差异", description: "人员人工 1200000 与 0 差异", requiresReview: true },
  { id: "i2", source: "compare_workpapers", issueType: "底稿差异", description: "含|竖线\n与换行", requiresReview: true },
  { id: "i3", source: "parse_uploaded_files", issueType: "提示", description: "无需复核的提示项", requiresReview: false },
];
const reviews: ReviewLike[] = [
  { issueId: "i1", decision: "confirm", comment: "经复核确认列入底稿", createdAt: "2026-09-28T09:00:00.000Z" },
];
expect("计数口径", reviewCounts(issues, reviews), { total: 3, done: 1, pending: 1, notRequired: 1 });
expect("无需复核不计入待复核", reviewCounts([issues[2]!], []).pending, 0);

const sec = reviewSection(issues, reviews, "completed");
expect("完成态仍有待复核时给出状态提示", sec.some((l) => l.includes("任务已标记完成但仍有 1 项未复核")), true);
expect("待复核全部复核后给出流转提示", reviewSection(issues, [...reviews, { issueId: "i2", decision: "dismiss", comment: "", createdAt: "2026-09-28T09:10:00.000Z" }], "waiting_review").some((l) => l.includes("任务将流转为已完成")), true);
expect("竖线与换行被安全化", sec.some((l) => l.includes("含\\|竖线 与换行")), true);
expect("决定文案映射", [DECISION_TEXT.confirm, DECISION_TEXT.dismiss], ["确认列入底稿", "判定无需处理"]);
expect("空意见写成（无）", reviewSection(issues, [...reviews, { issueId: "i2", decision: "dismiss", comment: "", createdAt: "2026-09-28T09:10:00.000Z" }], "completed").some((l) => l.includes("（无）")), true);
expect("没有问题时给出说明", reviewSection([], [], "completed").some((l) => l.includes("未产生需要人工复核的问题")), true);
expect("已复核按时间升序", reviewSection(
  [
    { id: "a", source: "s", issueType: "t", description: "后复核", requiresReview: true },
    { id: "b", source: "s", issueType: "t", description: "先复核", requiresReview: true },
  ],
  [
    { issueId: "a", decision: "confirm", comment: "", createdAt: "2026-09-28T10:00:00.000Z" },
    { issueId: "b", decision: "confirm", comment: "", createdAt: "2026-09-28T09:00:00.000Z" },
  ],
  "completed",
).find((l) => l.startsWith("| 1 |"))?.includes("先复核"), true);

// 2) 真实数据：导出的待复核数必须与后端 pendingReviewIssues 完全一致
let tasks = 0;
let withIssues = 0;
for (const t of listTasks()) {
  tasks += 1;
  checks += 1;
  const real = extractIssues(t.id);
  const revs = listReviews(t.id);
  const backend = pendingReviewIssues(t.id).length;
  const exported = reviewCounts(real, revs).pending;
  if (real.length > 0) withIssues += 1;
  if (exported !== backend) {
    failures.push(`${t.id} 导出待复核 ${exported} 与后端 ${backend} 不一致`);
  }
}
console.log(`[verify] 任务数=${tasks} 含问题任务=${withIssues}`);
console.log(`[verify] 复核导出检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 复核导出规则不符");
  process.exit(1);
}
console.log("[PASS] 复核导出规则正确（计数与后端同口径 / 转义 / 状态提示 / 排序）");
