/**
 * 验证脚本：证据核对表（九项核对结论 / 待办分组 / 整页 MD 片段 / 真实任务走查）。
 * 核对表是展示层，重点是「不丢项、不编数」：每项都能由输入推回，MD 与界面同一份生成逻辑。
 * 运行：pnpm verify:sheet
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.ts";
import { dirs } from "../src/config.ts";
import { getTask, listConclusions, listFiles, listTasks } from "../src/services/task-store.ts";
import { listAmountChecks } from "../src/services/amount-checks.ts";
import { listRefChecks } from "../src/services/ref-checks.ts";
import { pendingReviewIssues } from "../src/services/issues.ts";
import {
  extractCitations,
  extractTextCitations,
  mergeCitations,
  searchEvidence,
  searchFiltering,
} from "../../web/src/search-evidence.ts";
import { gradeCitation, summarizeGrades } from "../../web/src/citation-grade.ts";
import { traceDocRefs } from "../../web/src/policy-trace.ts";
import { refCheckTargets, refKey, summarizeRefChecks } from "../../web/src/ref-check.ts";
import { amountKey, traceAmounts } from "../../web/src/amount-trace.ts";
import { deliveryCheck } from "../../web/src/delivery-check.ts";
import { deltaDetail, deltaVerdict, evidenceDelta, evidenceSnapshot } from "../../web/src/revision-impact.ts";
import {
  evidenceSheetMarkdown,
  evidenceSheetDocument,
  evidenceSheetRows,
  evidenceSheetTodoGroups,
  evidenceSheetTodos,
  NO_TODO_TEXT,
  type SheetInput,
} from "../../web/src/evidence-sheet.ts";

const failures: string[] = [];
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

const full: SheetInput = {
  taskTitle: "示例任务",
  caseId: "RD-2026-001",
  agentName: "智研税审",
  statusText: "待复核",
  generatedAt: "2026-09-29T02:00:00.000Z",
  delivery: { verdict: "谨慎交付", blocks: 0, warns: 2, infos: 3 },
  docRefs: { total: 31, traced: 10, unverifiable: 21, untraced: 0, pending: 12 },
  docRefChecks: { total: 9, matched: 9, candidate: 0, empty: 0, error: 0, checkedAt: "2026-09-29T02:00:00.000Z" },
  citations: { total: 40, official: 32, professional: 6, weak: 2, fromTools: 30, fromConclusion: 10, replaced: 1 },
  citationChecks: { total: 2, matched: 1, candidate: 1, empty: 0, error: 0 },
  linkCheck: { total: 5, ok: 3, blocked: 1, dead: 1, unreachable: 0, checkedAt: "2026-09-29T01:00:00.000Z" },
  searches: { calls: 6, withUrls: 4, metadataOnly: 2, dropped: 12 },
  amounts: { total: 12, traced: 10, fromInput: 1, pending: 1, acked: 0 },
  revision: { verdict: "证据质量改善", detail: "弱证据引用 3 → 2（-1）" },
  todos: {
    docRefs: ["〔2006〕187号（未复查）"],
    weakCitations: ["研发_百度百科 https://baike.baidu.com/item/x/1"],
    deadLinks: ["https://dead.example.com/a"],
  },
};

// 1) 九项核对结论
const rows = evidenceSheetRows(full);
expect("核对项数量", rows.length, 9);
expect(
  "九项核对项名称与顺序",
  rows.map((r) => r.item),
  [
    "政策文号溯源",
    "政策文号联网复查",
    "联网引用证据力",
    "弱证据替代来源检索",
    "引用链接可达性",
    "联网检索留痕",
    "结论金额溯源",
    "本次修订对证据的影响",
    "交付自检",
  ],
);
ok("每项都有结论与说明", rows.every((r) => r.item !== "" && r.value !== "" && r.note !== ""));
expect("文号溯源结论", rows[0]?.value, "有出处 10/31");
ok("文号溯源说明含三类计数", (rows[0]?.note ?? "").includes("无法从留存数据核验 21") && (rows[0]?.note ?? "").includes("复查后仍无出处 12"), rows[0]?.note ?? "");
expect("文号复查结论", rows[1]?.value, "找到公开出处 9/9");
expect("引用证据力结论", rows[2]?.value, "官方原文 32/40");
ok(
  "引用说明含来源拆分与替代进度",
  (rows[2]?.note ?? "").includes("工具留存 30 / 结论正文 10") && (rows[2]?.note ?? "").includes("1 条已找到官方替代来源"),
  rows[2]?.note ?? "",
);
expect("替代来源检索结论", rows[3]?.value, "找到官方原文 1/2");
expect("链接核验结论", rows[4]?.value, "可访问 3/5");
ok("链接说明含失效数", (rows[4]?.note ?? "").includes("失效 1"), rows[4]?.note ?? "");
expect("检索留痕结论", rows[5]?.value, "检索 6 次");
ok("检索说明含拦下条数", (rows[5]?.note ?? "").includes("拦下无关结果与门户首页 12 条"), rows[5]?.note ?? "");
expect("金额溯源结论", rows[6]?.value, "可溯源 11/12");
ok("金额说明含待确认与已核对", (rows[6]?.note ?? "").includes("待人工确认 1（已人工核对 0）"), rows[6]?.note ?? "");
expect("修订影响结论", rows[7]?.value, "证据质量改善");
ok("修订说明写明口径", (rows[7]?.note ?? "").includes("只比结论正文"), rows[7]?.note ?? "");
expect("交付自检结论", rows[8]?.value, "谨慎交付");
expect("交付自检说明", rows[8]?.note, "阻断 0 项 · 提醒 2 项 · 说明 3 项");

// 2) 空输入的如实兜底
const bare: SheetInput = {
  ...full,
  docRefs: { total: 0, traced: 0, unverifiable: 0, untraced: 0, pending: 0 },
  docRefChecks: { total: 0, matched: 0, candidate: 0, empty: 0, error: 0, checkedAt: null },
  citations: { total: 0, official: 0, professional: 0, weak: 0, fromTools: 0, fromConclusion: 0, replaced: 0 },
  citationChecks: { total: 0, matched: 0, candidate: 0, empty: 0, error: 0 },
  linkCheck: null,
  searches: null,
  amounts: { total: 0, traced: 0, fromInput: 0, pending: 0, acked: 0 },
  revision: null,
  todos: { docRefs: [], weakCitations: [], deadLinks: [] },
};
const bareRows = evidenceSheetRows(bare);
expect("无文号时的结论", bareRows[0]?.value, "有出处 0/0");
ok("无文号时的说明", (bareRows[0]?.note ?? "").includes("没有出现税收规范性文件文号"), bareRows[0]?.note ?? "");
expect("未复查时的结论", bareRows[1]?.value, "未复查");
expect("无引用时的结论", bareRows[2]?.value, "无联网引用");
ok("无引用时提示确认在线核验", (bareRows[2]?.note ?? "").includes("在线核验"), bareRows[2]?.note ?? "");
expect("未检索替代来源时的结论", bareRows[3]?.value, "未检索");
expect("未核验链接时的结论", bareRows[4]?.value, "未核验");
expect("无检索调用时的结论", bareRows[5]?.value, "无检索调用");
expect("无金额时的结论", bareRows[6]?.value, "结论未出现金额");
expect("无可对比轮次时的结论", bareRows[7]?.value, "无可对比轮次");
expect("空输入也是九项", bareRows.length, 9);

// 3) 待办分组与 Markdown
expect("待办分组只列非空项", evidenceSheetTodoGroups(full).map((g) => g.list.length), [1, 1, 1]);
expect("没有待办时分组为空", evidenceSheetTodoGroups(bare).length, 0);
expect("没有待办时的 MD 行", evidenceSheetTodos(bare), [`- ${NO_TODO_TEXT}`]);
expect(
  "待办超过上限时写明总数",
  evidenceSheetTodos({ ...full, todos: { ...full.todos, deadLinks: Array.from({ length: 12 }, (_, i) => `https://d/${i}`) } }).some(
    (l) => l.includes("等 12 项"),
  ),
  true,
);
const md = evidenceSheetMarkdown(full).join("\n");
ok("MD 含表头", md.includes("| # | 核对项 | 结论 | 说明 |"));
ok("MD 含任务元信息", md.includes("示例任务") && md.includes("RD-2026-001") && md.includes("智研税审"));
for (const r of rows) {
  ok(`MD 含核对项「${r.item}」`, md.includes(r.item));
  ok(`MD 含「${r.item}」的结论`, md.includes(r.value));
}
ok("MD 含待办小节", md.includes("**交付前待办**"));
ok("MD 含核对人签字行", md.includes("核对人"));
ok("MD 含具体待办条目", md.includes("〔2006〕187号（未复查）"));

// 3b) 单页导出文档：与整页 MD 里的那一节内容一致，只多一个标题
const doc = evidenceSheetDocument(full);
expect("单页文档以 H1 开头", doc[0], "# 证据核对表");
expect("单页文档正文与 MD 节一致", doc.slice(2), evidenceSheetMarkdown(full));
ok("单页文档含签字行", doc.join("\n").includes("核对人"));
ok("单页文档含全部核对项", rows.every((r) => doc.join("\n").includes(r.item)));
ok("单页文档含任务元信息", doc.join("\n").includes("RD-2026-001"));
expect(
  "单元格里的竖线被转义",
  evidenceSheetMarkdown({ ...full, revision: { verdict: "a|b", detail: "c|d" } })
    .join("\n")
    .includes("a\\|b"),
  true,
);
// 待办是表格之外的列表项，竖线不需要转义，但要原样保留可读
expect(
  "待办条目原样进入 MD",
  evidenceSheetMarkdown({ ...full, todos: { ...full.todos, deadLinks: ["https://x/a?b=1&c=2"] } })
    .join("\n")
    .includes("https://x/a?b=1&c=2"),
  true,
);

// 4) 真实任务走查：核对表必须由真实数据算出，且不丢项
function sheetOf(taskId: string): SheetInput | null {
  const task = getTask(taskId);
  if (!task) return null;
  const rowsDb = db
    .prepare(`SELECT tool_name, result, ok FROM tool_calls WHERE task_id = ?`)
    .all(taskId) as unknown as Array<{ tool_name: string; result: string | null; ok: number | null }>;
  const calls = rowsDb.map((r) => {
    let result: unknown = null;
    try {
      result = r.result ? JSON.parse(r.result) : null;
    } catch {
      result = null;
    }
    return {
      toolName: r.tool_name,
      result,
      ok: r.ok === 1 ? true : r.ok === 0 ? false : null,
      at: "",
      endedAt: null,
      id: "",
    };
  });
  const text = task.result ?? "";
  const cites = mergeCitations(extractCitations(calls), extractTextCitations(text));
  const grades = summarizeGrades(cites);
  const se = searchEvidence(calls);
  const sf = searchFiltering(calls);
  const okResults = calls.filter((c) => c.ok !== false).map((c) => c.result);
  const refRecs = listRefChecks(taskId);
  // 复查判定「找到公开出处」的文号同样算有出处，与平台看板、结果页同一口径
  const tr = traceDocRefs(
    text,
    okResults,
    calls.map((c) => c.toolName),
    refRecs.filter((r) => r.kind === "docref" && r.verdict === "matched").map((r) => r.text),
  );
  const docSum = summarizeRefChecks(refRecs.filter((r) => r.kind === "docref"));
  const citeSum = summarizeRefChecks(refRecs.filter((r) => r.kind === "citation"));
  const pending = tr.untraced.length + tr.unverifiable;
  const amounts = traceAmounts(text, calls.map((c) => c.result), task.instruction ?? "");
  const acked = new Set(listAmountChecks(taskId).map((c) => c.key));
  const amountPending = amounts.untraced.filter((u) => !acked.has(amountKey(u))).length;
  const conclusions = listConclusions(taskId);
  const rev =
    conclusions.length >= 2
      ? (() => {
          const d = evidenceDelta(
            evidenceSnapshot(conclusions[conclusions.length - 2]!),
            evidenceSnapshot(conclusions[conclusions.length - 1]!),
          );
          return { verdict: deltaVerdict(d), detail: deltaDetail(d) };
        })()
      : null;
  const matchedDocs = new Set(refRecs.filter((r) => r.kind === "docref" && r.verdict === "matched").map((r) => r.key));
  const replaced = new Set(refRecs.filter((r) => r.kind === "citation" && r.verdict === "matched").map((r) => r.key));
  const targets = refCheckTargets(tr);
  const weak = cites.filter((c) => gradeCitation(c.url, c.title).grade === "weak");
  const dir = path.join(dirs.outputs, taskId);
  const arts = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()) : [];
  const delivery = deliveryCheck({
    status: task.status,
    resultChars: text.trim().length,
    artifacts: arts.length,
    unattributedArtifacts: 0,
    toolTotal: calls.length,
    toolFailed: calls.filter((c) => c.ok === false).length,
    toolRunning: calls.filter((c) => c.ok === null).length,
    pendingReview: pendingReviewIssues(taskId).length,
    citations: grades.total,
    citationGrades: grades.total > 0 ? grades : null,
    searches: se.calls > 0 ? se : null,
    linkCheck: null,
    linkCheckAgeHours: null,
    amountTotal: amounts.total,
    amountUntraced: amountPending,
    filesTotal: listFiles(taskId).length,
    filesFailed: 0,
    docRefTotal: tr.total,
    docRefTraced: tr.traced,
    docRefUnverifiable: tr.unverifiable,
    docRefUntraced: tr.untraced.length,
    docRefRecheck: docSum.total > 0 ? docSum : null,
    docRefPending: pending,
    citationRecheck: citeSum.total > 0 ? citeSum : null,
    revision: null,
  });
  return {
    taskTitle: task.title,
    caseId: task.caseId,
    agentName: task.agentId,
    statusText: task.status,
    generatedAt: "2026-09-29T02:00:00.000Z",
    delivery: { verdict: delivery.verdict, blocks: delivery.blocks, warns: delivery.warns, infos: delivery.infos },
    docRefs: {
      total: tr.total,
      traced: tr.traced,
      unverifiable: tr.unverifiable,
      untraced: tr.untraced.length,
      pending,
    },
    docRefChecks: docSum,
    citations: {
      total: grades.total,
      official: grades.official,
      professional: grades.professional,
      weak: grades.weak,
      fromTools: cites.filter((c) => c.via !== "conclusion").length,
      fromConclusion: cites.filter((c) => c.via === "conclusion").length,
      replaced: weak.filter((c) => replaced.has(refKey("citation", c.url))).length,
    },
    citationChecks: citeSum,
    linkCheck: null,
    searches: se.calls > 0 ? { calls: se.calls, withUrls: se.withUrls, metadataOnly: se.metadataOnly, dropped: sf.dropped } : null,
    amounts: {
      total: amounts.total,
      traced: amounts.traced,
      fromInput: amounts.fromInput,
      pending: amountPending,
      acked: amounts.untraced.length - amountPending,
    },
    revision: rev,
    todos: {
      docRefs: targets.filter((t) => !matchedDocs.has(t.key)).map((t) => t.text),
      weakCitations: weak.filter((c) => !replaced.has(refKey("citation", c.url))).map((c) => `${c.title} ${c.url}`),
      deadLinks: [],
    },
  };
}

let walked = 0;
let withTodos = 0;
for (const t of listTasks()) {
  const input = sheetOf(t.id);
  if (!input) continue;
  walked += 1;
  const rs = evidenceSheetRows(input);
  checks += 1;
  if (rs.length !== 9) failures.push(`${t.id.slice(0, 8)} 核对项不是 9 项`);
  checks += 1;
  if (rs.some((r) => r.item === "" || r.value === "" || r.note === "")) failures.push(`${t.id.slice(0, 8)} 有空缺的核对项`);
  // 结论必须能由输入推回：不允许出现输入里没有的数字
  checks += 1;
  if (!rs[0]!.value.includes(`${input.docRefs.traced}/${input.docRefs.total}`)) {
    failures.push(`${t.id.slice(0, 8)} 文号溯源结论与输入不符：${rs[0]!.value}`);
  }
  checks += 1;
  if (input.citations.total > 0 && !rs[2]!.value.includes(`${input.citations.official}/${input.citations.total}`)) {
    failures.push(`${t.id.slice(0, 8)} 引用证据力结论与输入不符：${rs[2]!.value}`);
  }
  checks += 1;
  if (rs[8]!.value !== input.delivery.verdict) failures.push(`${t.id.slice(0, 8)} 交付自检结论与输入不符`);
  // 待办清单必须与「仍无出处的文号 + 未替换的弱证据」一致
  const groups = evidenceSheetTodoGroups(input);
  checks += 1;
  const todoCount = groups.reduce((s, g) => s + g.list.length, 0);
  if (todoCount !== input.todos.docRefs.length + input.todos.weakCitations.length + input.todos.deadLinks.length) {
    failures.push(`${t.id.slice(0, 8)} 待办分组条数与输入不符`);
  }
  if (todoCount > 0) withTodos += 1;
  checks += 1;
  // 待办清单可能比 pending 多（上一版结论留下的 matched 记录不再对应当前文号），但不能更少
  if (input.docRefs.pending > input.todos.docRefs.length) {
    failures.push(
      `${t.id.slice(0, 8)} 复查后仍无出处 ${input.docRefs.pending} 处，多于待办清单的 ${input.todos.docRefs.length} 项`,
    );
  }
  const text2 = evidenceSheetMarkdown(input).join("\n");
  checks += 1;
  if (!rs.every((r) => text2.includes(r.item))) failures.push(`${t.id.slice(0, 8)} MD 缺少核对项`);
}
ok("真实任务全部能生成核对表", walked > 0, `实际 ${walked} 个`);
console.log(`[verify] 真实任务走查：${walked} 个任务生成核对表，其中 ${withTodos} 个仍有交付前待办`);

console.log(`[verify] 证据核对表检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 证据核对表规则不符");
  process.exit(1);
}
console.log("[PASS] 证据核对表正确（九项结论 / 空输入兜底 / 待办分组 / MD 片段 / 真实任务走查）");
