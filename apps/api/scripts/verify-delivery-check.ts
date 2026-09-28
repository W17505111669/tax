/**
 * 验证脚本：交付自检规则（整页交付 MD 的第一节）。
 * 含规则用例与全部真实任务的走查（结论与阻断项必须一一对应）。
 * 运行：pnpm verify:dcheck
 */
import { deliveryCheck, deliverySection, type CheckInput } from "../../web/src/delivery-check.ts";
import { pendingReviewIssues } from "../src/services/issues.ts";
import { listTasks, getTask } from "../src/services/task-store.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

const base: CheckInput = {
  status: "completed",
  resultChars: 3400,
  artifacts: 2,
  unattributedArtifacts: 0,
  toolTotal: 6,
  toolFailed: 0,
  toolRunning: 0,
  pendingReview: 0,
  citations: 3,
};

expect("全部达标 → 可交付", deliveryCheck(base).verdict, "可交付");
expect("可交付时无阻断无提醒", [deliveryCheck(base).blocks, deliveryCheck(base).warns], [0, 0]);
expect("完成但未复核 → 阻断", deliveryCheck({ ...base, pendingReview: 17 }).verdict, "不建议直接交付");
expect(
  "完成但未复核的阻断文案",
  deliveryCheck({ ...base, pendingReview: 17 }).items.some((x) => x.level === "block" && x.text.includes("17 项问题未复核")),
  true,
);
expect("待复核态的未复核项只是提醒", deliveryCheck({ ...base, status: "waiting_review", pendingReview: 2 }).verdict, "谨慎交付");
expect("执行中 → 阻断", deliveryCheck({ ...base, status: "processing" }).verdict, "不建议直接交付");
expect("失败 → 阻断", deliveryCheck({ ...base, status: "failed" }).verdict, "不建议直接交付");
expect("结论为空 → 阻断", deliveryCheck({ ...base, resultChars: 0 }).verdict, "不建议直接交付");
expect("有失败调用 → 提醒", deliveryCheck({ ...base, toolFailed: 1 }).verdict, "谨慎交付");
expect("有未结束调用 → 提醒", deliveryCheck({ ...base, toolRunning: 1 }).verdict, "谨慎交付");
expect("产物无法溯源 → 提醒", deliveryCheck({ ...base, unattributedArtifacts: 1 }).verdict, "谨慎交付");
expect("无联网引用 → 提醒", deliveryCheck({ ...base, citations: 0 }).verdict, "谨慎交付");
expect("多项阻断同时存在", deliveryCheck({ ...base, status: "processing", resultChars: 0 }).blocks, 2);
expect("失败叠加空结论", deliveryCheck({ ...base, status: "failed", resultChars: 0 }).blocks, 2);

const sec = deliverySection({ ...base, pendingReview: 5 });
expect("自检节首行给出结论", sec[0]?.startsWith("- 结论：不建议直接交付"), true);
expect("自检节标注任务状态", sec.some((l) => l.includes("任务状态：completed")), true);
expect("自检节含标记符号", sec.some((l) => l.startsWith("- ✗ ")) && sec.some((l) => l.startsWith("- ✓ ")), true);

// 真实任务走查：结论必须与阻断项数量一致；完成态且有未复核问题的任务必须被判为不可直接交付
let reopenable = 0;
for (const t of listTasks()) {
  checks += 1;
  const detail = getTask(t.id);
  const pending = pendingReviewIssues(t.id).length;
  const r = deliveryCheck({
    ...base,
    status: t.status,
    resultChars: (detail?.result ?? "").trim().length,
    pendingReview: pending,
  });
  if ((r.verdict === "不建议直接交付") !== (r.blocks > 0)) {
    failures.push(`${t.id} 结论 ${r.verdict} 与阻断项 ${r.blocks} 不一致`);
  }
  if (t.status === "completed" && pending > 0) {
    reopenable += 1;
    if (r.verdict !== "不建议直接交付") failures.push(`${t.id} 完成态有 ${pending} 项未复核但未判为阻断`);
  }
}
console.log(`[verify] 真实任务走查=${listTasks().length} 其中完成态待复核=${reopenable}`);
console.log(`[verify] 交付自检检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 交付自检规则不符");
  process.exit(1);
}
console.log("[PASS] 交付自检规则正确（阻断/提醒分级 + 真实任务走查）");
