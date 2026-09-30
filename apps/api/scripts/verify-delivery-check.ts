/**
 * 验证脚本：交付自检规则（整页交付 MD 的第一节）。
 * 含规则用例与全部真实任务的走查（结论与阻断项必须一一对应）。
 * 运行：pnpm verify:dcheck
 */
import { deliveryCheck, deliverySection, type CheckInput } from "../../web/src/delivery-check.ts";
import type { LinkSummary } from "../../web/src/link-check.ts";
import type { GradeSummary } from "../../web/src/citation-grade.ts";
import { pendingReviewIssues } from "../src/services/issues.ts";
import { listTasks, getTask } from "../src/services/task-store.ts";
import { db } from "../src/db.ts";
import { INTERRUPTED_ON_RESTART, isInterruptedOnRestart, taskStatusLabel } from "../../web/src/task-status.ts";

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
  citationGrades: { total: 3, official: 2, professional: 1, weak: 0 },
  offTopicCitations: [],
  searches: { calls: 2, withUrls: 2, metadataOnly: 0, reportedResults: 0 },
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
  docRefRecheck: null,
  docRefPending: 0,
  citationRecheck: null,
  revision: null,
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
expect("既无引用也没检索 → 提醒", deliveryCheck({ ...base, citations: 0, searches: null }).verdict, "谨慎交付");
expect(
  "没检索时的提醒文案",
  deliveryCheck({ ...base, citations: 0, searches: null }).items.some(
    (x) => x.level === "warn" && x.text.includes("无联网引用"),
  ),
  true,
);
expect(
  "检索过但只留元数据 → 说明而非提醒",
  deliveryCheck({
    ...base,
    citations: 0,
    citationGrades: null,
    searches: { calls: 3, withUrls: 0, metadataOnly: 3, reportedResults: 15 },
  }).verdict,
  "可交付",
);
expect(
  "元数据检索的说明含次数与自报命中数",
  deliveryCheck({
    ...base,
    citations: 0,
    citationGrades: null,
    searches: { calls: 3, withUrls: 0, metadataOnly: 3, reportedResults: 15 },
  }).items.some((x) => x.level === "info" && x.text.includes("3 次联网检索") && x.text.includes("15 条")),
  true,
);
expect(
  "有引用又有元数据检索 → 追加说明",
  deliveryCheck({ ...base, searches: { calls: 3, withUrls: 1, metadataOnly: 2, reportedResults: 8 } }).items.some(
    (x) => x.level === "info" && x.text.includes("另有 2 次联网检索"),
  ),
  true,
);
expect(
  "元数据检索说明计入 info 不计入 warn",
  deliveryCheck({
    ...base,
    citations: 0,
    citationGrades: null,
    searches: { calls: 1, withUrls: 0, metadataOnly: 1, reportedResults: 0 },
  }).warns,
  0,
);
expect(
  "有引用但没有检索调用时说明引用取自结论正文",
  deliveryCheck({ ...base, searches: null }).items.some(
    (x) => x.level === "info" && x.text.includes("取自结论正文"),
  ),
  true,
);
expect(
  "有检索调用时不误报引用来自正文",
  deliveryCheck(base).items.some((x) => x.text.includes("取自结论正文")),
  false,
);
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
// 已在结论中标注「未取得公开原文，仅作背景参考，不作为政策依据」的文号不是交付前待办：
// 查不到公开原文时如实标注就是设计好的收口，标注完还继续提醒，认真照做的任务永远出不了「谨慎交付」
const labeledDocRefs = {
  ...base,
  docRefTotal: 3,
  docRefTraced: 1,
  docRefUntraced: 2,
  docRefPending: 2,
  docRefLabeled: { untraced: 2, unverifiable: 0 },
};
expect("文号全部已标注 → 不再降级", deliveryCheck(labeledDocRefs).verdict, "可交付");
expect(
  "已标注的处数单独给正向条目",
  deliveryCheck(labeledDocRefs).items.some((x) => x.level === "ok" && x.text.includes("2 处政策文号已在结论中标注")),
  true,
);
expect(
  "只标注了一部分时按剩下的提醒",
  deliveryCheck({ ...labeledDocRefs, docRefLabeled: { untraced: 1, unverifiable: 0 } }).items.some(
    (x) => x.level === "warn" && x.text.includes("1 处政策文号未找到公开出处"),
  ),
  true,
);
expect(
  "无法核验的文号标注后也不再计入说明",
  deliveryCheck({
    ...base,
    docRefTotal: 3,
    docRefTraced: 1,
    docRefUnverifiable: 2,
    docRefPending: 2,
    docRefLabeled: { untraced: 0, unverifiable: 2 },
  }).infos,
  0,
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

// 政策文号联网复查：查到公开出处的部分不再算风险
const recheck = (over: Partial<NonNullable<CheckInput["docRefRecheck"]>> = {}) => ({
  total: 2,
  matched: 2,
  candidate: 0,
  empty: 0,
  error: 0,
  checkedAt: "2026-09-29T02:00:00.000Z",
  ...over,
});
// 复查判定 matched 的文号已计入 docRefTraced，不会再出现在 untraced / unverifiable 里，
// 因此「待复查为 0 却仍有未溯源文号」这个状态不存在，旧的降级分支随之删除。
expect(
  "复查到出处的文号算已有出处 → 可交付",
  deliveryCheck({
    ...base,
    docRefTotal: 3,
    docRefTraced: 3,
    docRefUntraced: 0,
    docRefRecheck: recheck({ total: 3, matched: 3 }),
    docRefPending: 0,
  }).verdict,
  "可交付",
);
expect(
  "全部有出处时写明出处含联网复查",
  deliveryCheck({
    ...base,
    docRefTotal: 3,
    docRefTraced: 3,
    docRefRecheck: recheck({ total: 3, matched: 3 }),
  }).items.some((x) => x.level === "ok" && x.text.includes("联网复查")),
  true,
);
expect(
  "仍未溯源的文号保持提醒",
  deliveryCheck({
    ...base,
    docRefTotal: 3,
    docRefTraced: 1,
    docRefUntraced: 2,
    docRefPending: 2,
  }).items.some((x) => x.level === "warn" && x.text.includes("未找到公开出处")),
  true,
);
expect(
  "复查只覆盖一部分时仍是提醒",
  deliveryCheck({
    ...base,
    docRefTotal: 4,
    docRefTraced: 1,
    docRefUntraced: 3,
    docRefRecheck: recheck({ total: 1, matched: 1 }),
    docRefPending: 2,
  }).verdict,
  "谨慎交付",
);
expect(
  "复查正向条目含剩余处数",
  deliveryCheck({
    ...base,
    docRefUntraced: 3,
    docRefRecheck: recheck({ total: 1, matched: 1 }),
    docRefPending: 2,
  }).items.some((x) => x.level === "ok" && x.text.includes("仍有 2 处没有出处")),
  true,
);
expect(
  "只找到候选页时仅作说明",
  deliveryCheck({ ...base, docRefRecheck: recheck({ matched: 0, candidate: 2 }) }).items.some(
    (x) => x.level === "info" && x.text.includes("2 处文号复查只找到候选页面"),
  ),
  true,
);
expect(
  "未检索到不降级",
  deliveryCheck({ ...base, docRefRecheck: recheck({ matched: 0, empty: 2 }) }).verdict,
  "可交付",
);
expect(
  "检索失败仅作说明",
  deliveryCheck({ ...base, docRefRecheck: recheck({ matched: 0, error: 2 }) }).items.some(
    (x) => x.level === "info" && x.text.includes("2 处检索失败"),
  ),
  true,
);
expect(
  "无法核验的文号复查到出处后不再提醒",
  deliveryCheck({
    ...base,
    docRefTotal: 3,
    docRefTraced: 1,
    docRefUnverifiable: 2,
    docRefRecheck: recheck(),
    docRefPending: 0,
  }).verdict,
  "可交付",
);
expect(
  "复查到出处后不再算无法核验，也不再建议改用快照",
  deliveryCheck({
    ...base,
    docRefTotal: 3,
    docRefTraced: 3,
    docRefUnverifiable: 0,
    docRefRecheck: recheck({ total: 3, matched: 3 }),
    docRefPending: 0,
  }).items.some((x) => x.text.includes("建议改用政策快照检索")),
  false,
);
expect(
  "未复查时仍建议改用快照或联网复查",
  deliveryCheck({ ...base, docRefTotal: 3, docRefUnverifiable: 3 }).items.some(
    (x) => x.level === "info" && x.text.includes("建议改用政策快照检索"),
  ),
  true,
);

// 弱证据引用的替代来源检索：只作说明，弱证据本身在人工替换前仍算风险
const crecheck = (over: Partial<NonNullable<CheckInput["citationRecheck"]>> = {}) => ({
  total: 2,
  matched: 2,
  candidate: 0,
  empty: 0,
  error: 0,
  checkedAt: "2026-09-29T03:00:00.000Z",
  ...over,
});
const weakInput = { ...base, citationGrades: { total: 3, official: 1, professional: 0, weak: 2 } };
expect(
  "找到替代来源时给出说明",
  deliveryCheck({ ...weakInput, citationRecheck: crecheck() }).items.some(
    (x) => x.level === "info" && x.text.includes("2 条弱证据引用已找到可替换的官方原文"),
  ),
  true,
);
expect(
  "弱证据在人工替换前仍是提醒",
  deliveryCheck({ ...weakInput, citationRecheck: crecheck() }).verdict,
  "谨慎交付",
);
expect(
  "只有候选页时说明需人工确认",
  deliveryCheck({ ...weakInput, citationRecheck: crecheck({ matched: 0, candidate: 2 }) }).items.some(
    (x) => x.level === "info" && x.text.includes("需人工确认后再替换"),
  ),
  true,
);
expect(
  "全部没找到时说明改用政策快照",
  deliveryCheck({ ...weakInput, citationRecheck: crecheck({ matched: 0, empty: 2 }) }).items.some(
    (x) => x.level === "info" && x.text.includes("没有检索到可替换的官方原文"),
  ),
  true,
);
expect(
  "没有弱证据时不产生替代来源条目",
  deliveryCheck({ ...base, citationRecheck: crecheck() }).items.some((x) => x.text.includes("替代")),
  false,
);

// 本次修订对证据的影响：改坏了要在交付前拦住
const rev = (over: Partial<NonNullable<CheckInput["revision"]>> = {}) => ({
  citations: 0,
  official: 1,
  weak: -2,
  docRefs: 0,
  improved: true,
  regressed: false,
  ...over,
});
expect(
  "修订改善给出正向条目",
  deliveryCheck({ ...base, revision: rev() }).items.some(
    (x) => x.level === "ok" && x.text.includes("本次修订改善了证据质量"),
  ),
  true,
);
expect(
  "修订改善不降级",
  deliveryCheck({ ...base, revision: rev() }).verdict,
  "可交付",
);
expect(
  "修订退步 → 提醒",
  deliveryCheck({ ...base, revision: rev({ official: -1, weak: 2, improved: false, regressed: true }) }).verdict,
  "谨慎交付",
);
expect(
  "退步提示含带符号差值",
  deliveryCheck({ ...base, revision: rev({ official: -1, weak: 2, improved: false, regressed: true }) }).items.some(
    (x) => x.level === "warn" && x.text.includes("弱证据引用 +2") && x.text.includes("官方来源 -1"),
  ),
  true,
);
expect(
  "有增有减只作说明不降级",
  deliveryCheck({ ...base, revision: rev({ official: -1, weak: -1, improved: true, regressed: true }) }).verdict,
  "可交付",
);
expect(
  "有增有减的说明文案",
  deliveryCheck({ ...base, revision: rev({ official: -1, weak: -1, improved: true, regressed: true }) }).items.some(
    (x) => x.level === "info" && x.text.includes("有增有减"),
  ),
  true,
);
expect(
  "质量持平时不产生修订条目",
  deliveryCheck({ ...base, revision: rev({ official: 0, weak: 0, improved: false, regressed: false }) }).items.some(
    (x) => x.text.includes("本次修订"),
  ),
  false,
);
expect(
  "没有可对比结论时不产生修订条目",
  deliveryCheck(base).items.some((x) => x.text.includes("本次修订")),
  false,
);
expect("多项阻断同时存在", deliveryCheck({ ...base, status: "processing", resultChars: 0 }).blocks, 2);
expect("失败叠加空结论", deliveryCheck({ ...base, status: "failed", resultChars: 0 }).blocks, 2);

// 引用证据力分级：门户首页 / 百科词条 / 检索页不能替代政策原文
const grades = (over: Partial<GradeSummary> = {}): GradeSummary => ({
  total: 3,
  official: 2,
  professional: 1,
  weak: 0,
  ...over,
});
expect(
  "官方原文引用给出正向条目",
  deliveryCheck(base).items.some((x) => x.level === "ok" && x.text.includes("2 条联网引用来自政府")),
  true,
);
expect(
  "存在弱证据引用 → 提醒",
  deliveryCheck({ ...base, citationGrades: grades({ official: 1, professional: 0, weak: 2 }) }).verdict,
  "谨慎交付",
);
expect(
  "弱证据提示含条数与替换建议",
  deliveryCheck({ ...base, citationGrades: grades({ official: 1, professional: 0, weak: 2 }) }).items.some(
    (x) => x.level === "warn" && x.text.includes("2 条联网引用指向门户首页") && x.text.includes("替换"),
  ),
  true,
);
expect(
  "全是专业来源时不降级",
  deliveryCheck({ ...base, citationGrades: grades({ official: 0, professional: 3, weak: 0 }) }).verdict,
  "可交付",
);
expect(
  "无联网引用时不产生分级条目",
  deliveryCheck({ ...base, citations: 0, citationGrades: null }).items.some((x) => x.text.includes("证据力")),
  false,
);
expect(
  "弱证据提醒计入 warns 而非 info",
  deliveryCheck({ ...base, citationGrades: grades({ official: 0, professional: 0, weak: 3 }) }).warns,
  1,
);
// 结论里已写明「仅作背景参考，不作为政策依据」的弱证据不是交付前待办：再催替换只是噪音
const allDisclaimed = {
  ...base,
  citationGrades: { ...grades({ official: 0, professional: 0, weak: 3 }), weakDisclaimed: 3 },
};
expect("弱证据全部已声明为背景参考时不再提醒", deliveryCheck(allDisclaimed).warns, 0);
expect(
  "已声明的条数单独给正向条目",
  deliveryCheck(allDisclaimed).items.some((x) => x.level === "ok" && x.text.includes("3 条弱证据引用已在结论中声明")),
  true,
);
expect(
  "只声明了一部分时按剩下待处置的条数提醒",
  deliveryCheck({
    ...base,
    citationGrades: { ...grades({ official: 0, professional: 0, weak: 3 }), weakDisclaimed: 1 },
  }).items.some((x) => x.level === "warn" && x.text.includes("2 条联网引用指向门户首页")),
  true,
);
expect(
  "全部已声明后不再催检索替代来源",
  deliveryCheck({ ...allDisclaimed, citationRecheck: crecheck({ matched: 2 }) }).items.some((x) =>
    x.text.includes("已找到可替换的官方原文"),
  ),
  false,
);
// 只在检索留存里、从未进入结论正文的弱证据同样不是交付前待办：不是这份材料的依据，也没处补标注
const allUncited = {
  ...base,
  citationGrades: { ...grades({ official: 0, professional: 0, weak: 3 }), weakUncited: 3 },
};
expect("弱证据全部未进结论正文时不再提醒", deliveryCheck(allUncited).warns, 0);
expect(
  "未进结论正文的条数给说明而不是提醒",
  deliveryCheck(allUncited).items.some(
    (x) => x.level === "info" && x.text.includes("3 条弱证据引用只存在于检索留存"),
  ),
  true,
);
expect(
  "两类同时存在时按剩下待处置的条数提醒",
  deliveryCheck({
    ...base,
    citationGrades: { ...grades({ official: 0, professional: 0, weak: 6 }), weakDisclaimed: 2, weakUncited: 3 },
  }).items.some((x) => x.level === "warn" && x.text.includes("1 条联网引用指向门户首页")),
  true,
);

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

// 与业务主题无关的泛词条引用：找不到同主题的官方原文，该删而不是该替换
expect(
  "跑题引用给出提醒并写清条数",
  deliveryCheck({
    ...base,
    offTopicCitations: ["国家（政治地理学名词）_百度百科", "国家政务服务平台"],
  }).items.some((x) => x.level === "warn" && x.text.includes("2 条联网引用与业务主题无关")),
  true,
);
expect(
  "跑题提醒列出样例标题",
  deliveryCheck({ ...base, offTopicCitations: ["土地（汉语词语）_百度百科"] }).items.some((x) =>
    x.text.includes("「土地（汉语词语）_百度百科」"),
  ),
  true,
);
expect(
  "跑题提醒写明建议删除而不是找替代来源",
  deliveryCheck({ ...base, offTopicCitations: ["国家政务服务平台"] }).items.some((x) =>
    x.text.includes("建议直接从结论中删掉"),
  ),
  true,
);
expect("跑题引用是提醒不是阻断", deliveryCheck({ ...base, offTopicCitations: ["国家数据"] }).verdict, "谨慎交付");
expect("没有跑题引用时不产生该条目", deliveryCheck(base).items.some((x) => x.text.includes("与业务主题无关")), false);
expect(
  "样例最多列三条，不把所有标题堆进一句话",
  (deliveryCheck({ ...base, offTopicCitations: ["甲", "乙", "丙", "丁"] }).items.find((x) =>
    x.text.includes("与业务主题无关"),
  )?.text ?? "").includes("丁"),
  false,
);

// failed 承担两种完全不同的事实：服务重启打断（续跑就行、结论并没有错）与 Agent 执行真的失败
//（要查错误原因）。此前界面统一写「已中断」、交付自检写「任务执行失败，结论不可用」，
// 同一件事两种说法，而且两种各自都只对一半。
expect("服务重启打断算中断", isInterruptedOnRestart({ status: "failed", error: INTERRUPTED_ON_RESTART }), true);
expect("执行报错不算中断", isInterruptedOnRestart({ status: "failed", error: "模型调用超时" }), false);
expect("没有错误串不算中断", isInterruptedOnRestart({ status: "failed", error: null }), false);
expect(
  "非 failed 状态即使带这句也不算中断",
  isInterruptedOnRestart({ status: "completed", error: INTERRUPTED_ON_RESTART }),
  false,
);
expect("中断的完整说法", taskStatusLabel("failed", INTERRUPTED_ON_RESTART), "已中断（服务重启）");
expect("执行失败的完整说法", taskStatusLabel("failed", "模型调用超时"), "执行失败");
expect("其余状态沿用既有措辞", taskStatusLabel("waiting_review"), "待复核");
expect("未知状态原样返回不猜", taskStatusLabel("weird_status"), "weird_status");
expect(
  "中断的阻断项指向续跑而不是查错",
  deliveryCheck({ ...base, status: "failed", error: INTERRUPTED_ON_RESTART }).items.some(
    (x) => x.level === "block" && x.text.includes("续跑"),
  ),
  true,
);
expect(
  "执行失败的阻断项仍写结论不可用",
  deliveryCheck({ ...base, status: "failed", error: "模型调用超时" }).items.some((x) =>
    x.text.includes("任务执行失败，结论不可用"),
  ),
  true,
);
expect(
  "没给错误串时按执行失败处理：宁可说得重，也不能把真失败说成续跑就行",
  deliveryCheck({ ...base, status: "failed" }).items.some((x) => x.text.includes("任务执行失败，结论不可用")),
  true,
);
expect("两种情况都是阻断项", deliveryCheck({ ...base, status: "failed", error: INTERRUPTED_ON_RESTART }).blocks, 1);

// 与库里真实数据对齐：列表接口的标记必须等于按错误串直接数出来的条数，否则说明判据与落库口径漂了
const realFailed = listTasks().filter((t) => t.status === "failed").length;
const realInterrupted = listTasks().filter((t) => t.status === "failed" && t.interrupted).length;
const sqlFailed = (db.prepare(`SELECT COUNT(*) n FROM tasks WHERE status = 'failed'`).get() as { n: number }).n;
const sqlInterrupted = (
  db.prepare(`SELECT COUNT(*) n FROM tasks WHERE status = 'failed' AND error LIKE '%' || ? || '%'`).get(INTERRUPTED_ON_RESTART) as {
    n: number;
  }
).n;
expect("列表接口的 failed 总数与库里一致", realFailed, sqlFailed);
expect("列表接口的中断标记与按错误串直接数出来的一致", realInterrupted, sqlInterrupted);
// 措辞里不写英文 failed：门禁输出常用不区分大小写的 FAIL 检索，写了会被自己误命中
console.log(
  `[verify] 任务状态口径：失败态 ${realFailed} 个 = 服务重启中断 ${realInterrupted} 个 + 执行报错 ${realFailed - realInterrupted} 个`,
);

console.log(`[verify] 交付自检检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 交付自检规则不符");
  process.exit(1);
}
console.log("[PASS] 交付自检规则正确（阻断/提醒分级 + 真实任务走查）");
