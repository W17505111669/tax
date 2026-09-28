/**
 * 验证脚本：交付自检规则（整页交付 MD 的第一节）。
 * 含规则用例与全部真实任务的走查（结论与阻断项必须一一对应）。
 * 运行：pnpm verify:dcheck
 */
import { deliveryCheck, deliverySection, type CheckInput } from "../../web/src/delivery-check.ts";
import type { LinkSummary } from "../../web/src/link-check.ts";
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
  linkCheck: null,
  linkCheckAgeHours: null,
  amountTotal: 12,
  amountUntraced: 0,
  filesTotal: 2,
  filesFailed: 0,
  docRefTotal: 0,
  docRefTraced: 0,
  docRefUnverifiable: 0,
  docRefUntraced: 0,
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
expect("金额全部可溯源 → 不降级", deliveryCheck(base).verdict, "可交付");
expect("存在未溯源金额 → 提醒", deliveryCheck({ ...base, amountUntraced: 3 }).verdict, "谨慎交付");
expect(
  "未溯源金额提示含处数",
  deliveryCheck({ ...base, amountUntraced: 3 }).items.some((x) => x.level === "warn" && x.text.includes("3 处结论金额")),
  true,
);
expect(
  "金额可溯源时给出正向结论",
  deliveryCheck(base).items.some((x) => x.level === "ok" && x.text.includes("结论金额 12 处")),
  true,
);
expect("结论无金额时不产生金额条目", deliveryCheck({ ...base, amountTotal: 0 }).items.some((x) => x.text.includes("结论金额")), false);
const links = (over: Partial<LinkSummary> = {}): LinkSummary => ({
  total: 3,
  ok: 3,
  blocked: 0,
  dead: 0,
  unreachable: 0,
  ...over,
});
expect("未核验链接时不做判断", deliveryCheck(base).items.some((x) => x.text.includes("核验")), false);
expect("有失效引用 → 提醒", deliveryCheck({ ...base, linkCheck: links({ ok: 1, dead: 2 }) }).verdict, "谨慎交付");
expect(
  "失效引用提示含条数",
  deliveryCheck({ ...base, linkCheck: links({ ok: 1, dead: 2 }) }).items.some((x) => x.text.includes("2 条联网引用已失效")),
  true,
);
expect("反爬拒绝只作说明、不降级", deliveryCheck({ ...base, linkCheck: links({ ok: 1, blocked: 2 }) }).verdict, "可交付");
expect("反爬说明计入 info", deliveryCheck({ ...base, linkCheck: links({ ok: 1, blocked: 2 }) }).infos, 1);
expect("无法核验也只作说明", deliveryCheck({ ...base, linkCheck: links({ ok: 2, unreachable: 1 }) }).verdict, "可交付");
expect("全部可访问 → 可交付", deliveryCheck({ ...base, linkCheck: links() }).verdict, "可交付");
expect(
  "全部可访问时的正向条目",
  deliveryCheck({ ...base, linkCheck: links() }).items.some((x) => x.level === "ok" && x.text.includes("全部可访问")),
  true,
);
expect(
  "核验超过 72 小时给出说明",
  deliveryCheck({ ...base, linkCheck: links(), linkCheckAgeHours: 96 }).items.some(
    (x) => x.level === "info" && x.text.includes("已超过 4 天"),
  ),
  true,
);
expect("核验未过期不给说明", deliveryCheck({ ...base, linkCheck: links(), linkCheckAgeHours: 10 }).infos, 0);
expect("未核验时不判断时效", deliveryCheck({ ...base, linkCheckAgeHours: 999 }).infos, 0);
expect("时效说明不影响判定", deliveryCheck({ ...base, linkCheck: links(), linkCheckAgeHours: 96 }).verdict, "可交付");
expect("资料全部解析成功 → 正向条目", deliveryCheck(base).items.some((x) => x.text.includes("上传资料 2 份")), true);
expect("有资料解析失败 → 提醒", deliveryCheck({ ...base, filesFailed: 1 }).verdict, "谨慎交付");
expect(
  "解析失败提示含份数",
  deliveryCheck({ ...base, filesFailed: 1 }).items.some((x) => x.text.includes("1 份上传资料解析失败")),
  true,
);
expect("无资料时不产生资料条目", deliveryCheck({ ...base, filesTotal: 0 }).items.some((x) => x.text.includes("上传资料")), false);
expect("文号无出处 → 提醒", deliveryCheck({ ...base, docRefTotal: 3, docRefTraced: 1, docRefUntraced: 2 }).verdict, "谨慎交付");
expect(
  "文号提醒含处数",
  deliveryCheck({ ...base, docRefTotal: 3, docRefTraced: 1, docRefUntraced: 2 }).items.some(
    (x) => x.level === "warn" && x.text.includes("2 处政策文号"),
  ),
  true,
);
expect(
  "文号无法核验只作说明、不降级",
  deliveryCheck({ ...base, docRefTotal: 3, docRefTraced: 1, docRefUnverifiable: 2 }).verdict,
  "可交付",
);
expect(
  "文号无法核验计入 info",
  deliveryCheck({ ...base, docRefTotal: 3, docRefTraced: 1, docRefUnverifiable: 2 }).infos,
  1,
);
expect(
  "文号全部有出处 → 正向条目",
  deliveryCheck({ ...base, docRefTotal: 4, docRefTraced: 4 }).items.some(
    (x) => x.level === "ok" && x.text.includes("政策文号 4 处"),
  ),
  true,
);
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
