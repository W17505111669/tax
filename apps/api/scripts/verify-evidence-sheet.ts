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
import { listLinkChecks } from "../src/services/link-checks.ts";
import { pendingReviewIssues } from "../src/services/issues.ts";
import {
  extractCitations,
  extractTextCitations,
  mergeCitations,
  searchEvidence,
  searchFiltering,
  UNCAPPED,
  SEARCH_TOOL_NAMES,
} from "../../web/src/search-evidence.ts";
import { gradeCitation, summarizeGrades } from "../../web/src/citation-grade.ts";
import { traceDocRefs } from "../../web/src/policy-trace.ts";
import {
  disclaimedWeakUrls,
  labeledDocRefTexts,
  settledWeakUrls,
  offTopicCitationTitles,
  refCheckTargets,
  refKey,
  summarizeRefChecks,
} from "../../web/src/ref-check.ts";
import { amountKey, classifyUntraced, TEXT_AMOUNT_TOOLS, traceAmounts } from "../../web/src/amount-trace.ts";
import { deliveryCheck } from "../../web/src/delivery-check.ts";
import { ageHours, linkVerdict, liveLinkChecks, summarizeLinkChecks } from "../../web/src/link-check.ts";
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
  docRefs: { total: 31, traced: 10, unverifiable: 21, untraced: 0, pending: 12, labeled: 12 },
  docRefChecks: { total: 9, matched: 9, candidate: 0, empty: 0, error: 0, checkedAt: "2026-09-29T02:00:00.000Z" },
  citations: {
    total: 40,
    official: 32,
    professional: 6,
    weak: 2,
    fromTools: 30,
    fromConclusion: 10,
    replaced: 1,
    disclaimed: 1,
  },
  citationChecks: { total: 2, matched: 1, candidate: 1, empty: 0, error: 0 },
  linkCheck: { total: 5, ok: 3, blocked: 1, dead: 1, unreachable: 0, checkedAt: "2026-09-29T01:00:00.000Z" },
  searches: { calls: 6, withUrls: 4, metadataOnly: 2, dropped: 12 },
  amounts: { total: 12, traced: 10, fromInput: 1, pending: 1, acked: 0, pendingWeb: 1, pendingUnexplained: 0 },
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
ok(
  "文号溯源说明写出已标注为背景参考的处数",
  (rows[0]?.note ?? "").includes("其中 12 处已在结论中标注为背景参考"),
  rows[0]?.note ?? "",
);
// 金额溯源这一项：待确认要按「为什么找不到出处」拆开报，混在一个数里时检索类任务的大批量引文
// 会把真正要拦的「三处均无出处」淹掉。按项目名取行，不按位置取下标（插一项就全错位）。
const amountRow = rows.find((r) => r.item === "结论金额溯源");
ok("核对表确实有金额溯源这一项", amountRow !== undefined);
ok(
  "待确认金额在核对表里按两类拆开报",
  (amountRow?.note ?? "").includes("其中引自联网正文 1 处") &&
    (amountRow?.note ?? "").includes("三处均无出处 0 处"),
  amountRow?.note ?? "",
);
// 还没复查过、但待复查的都已在结论里标注时，不该再催人去点复查
const noRecheck = evidenceSheetRows({
  ...full,
  docRefChecks: { total: 0, matched: 0, candidate: 0, empty: 0, error: 0, checkedAt: null },
});
ok(
  "未复查且全部已标注时不再催复查",
  (noRecheck[1]?.note ?? "").includes("已在结论中标注「未取得公开原文，仅作背景参考」，无需复查"),
  noRecheck[1]?.note ?? "",
);
const partlyLabeled = evidenceSheetRows({
  ...full,
  docRefChecks: { total: 0, matched: 0, candidate: 0, empty: 0, error: 0, checkedAt: null },
  docRefs: { ...full.docRefs, labeled: 5 },
});
ok(
  "未复查且只标注了一部分时按剩下的催",
  (partlyLabeled[1]?.note ?? "").includes("尚有 7 处没有出处"),
  partlyLabeled[1]?.note ?? "",
);
expect("文号复查结论", rows[1]?.value, "找到公开出处 9/9");
expect("引用证据力结论", rows[2]?.value, "官方来源 32/40");
ok(
  "引用说明含来源拆分与替代进度",
  (rows[2]?.note ?? "").includes("工具留存 30 / 结论正文 10") && (rows[2]?.note ?? "").includes("1 条已找到官方替代来源"),
  rows[2]?.note ?? "",
);
ok(
  "引用说明写明已声明为背景参考的条数",
  (rows[2]?.note ?? "").includes("1 条已在结论中声明为背景参考"),
  rows[2]?.note ?? "",
);
expect("替代来源检索结论", rows[3]?.value, "找到官方原文 1/2");
// 还没检索过替代来源时，提示要给「待处置」的条数：已声明为背景参考的不该再催人去找替代
const unsearched = evidenceSheetRows({
  ...full,
  citationChecks: { total: 0, matched: 0, candidate: 0, empty: 0, error: 0 },
  citations: { ...full.citations, weak: 3, disclaimed: 1 },
});
ok("未检索替代来源时按待处置条数提示", (unsearched[3]?.note ?? "").includes("尚有 2 条弱证据引用待处置"), unsearched[3]?.note ?? "");
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
  amounts: { total: 0, traced: 0, fromInput: 0, pending: 0, acked: 0, pendingWeb: 0, pendingUnexplained: 0 },
  revision: null,
  todos: { docRefs: [], weakCitations: [], deadLinks: [] },
};
const bareRows = evidenceSheetRows(bare);
const bareAmountRow = bareRows.find((r) => r.item === "结论金额溯源");
ok(
  "待确认为 0 时不写两类拆分（不填占位数字）",
  !(bareAmountRow?.note ?? "").includes("其中引自联网正文"),
  bareAmountRow?.note ?? "",
);
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
/**
 * 走查中真实遇到的链接核验规模。三者任一为 0 都说明「引用链接可达性」这一项与「已失效链接」
 * 这一组待办仍是空跑——此前 sheetOf 里写死 linkCheck: null / deadLinks: []，40 个真实任务
 * 走下来那两处从来没被真实数据碰过，门禁却一直是绿的。
 */
let lcTasks = 0;
let lcRowsTotal = 0;
let lcStaleTotal = 0;
/** 过滤前后待办条数不同的任务数：为 0 就说明这道过滤在真实数据上没起任何作用，等于没验 */
let lcDiverged = 0;
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
  // 与结果页、平台统计同口径：全量提取，不套用界面清单上限。带上限的话排在第 25 条之后的引用根本
  // 不进走查，弱证据与「已声明 / 未进结论」的计数也会比看板少（实测 26 条对 23 条），
  // 走查就验证不到界面真正在算的那份清单
  const cites = mergeCitations(
    extractCitations(calls, UNCAPPED),
    extractTextCitations(text, UNCAPPED),
    UNCAPPED,
  );
  const grades = summarizeGrades(cites);
  // 链接核验：与结果页同一判据（link-check.ts 的 liveLinkChecks）——只算地址仍在当前引用清单里的行。
  // link_checks 按 (task_id, url) upsert 且从不删行，结论续跑或回滚之后旧地址的行仍挂在库里。
  const lcRows = listLinkChecks(taskId);
  const citeUrls = new Set(cites.map((c) => c.url));
  const lcLive = liveLinkChecks(lcRows, citeUrls);
  const lcSum = summarizeLinkChecks(lcLive);
  // 核验时间取全量行的最大值（与服务端 GET /link-checks 同一口径），计数只算 live 行（与结果页同口径）
  const lcAt = lcRows.reduce((m, r) => (r.checkedAt && r.checkedAt > m ? r.checkedAt : m), "") || null;
  if (lcRows.length > 0) {
    lcTasks += 1;
    lcRowsTotal += lcRows.length;
    lcStaleTotal += lcRows.length - lcLive.length;
  }
  // 待办里的失效链接：两种口径各算一遍。旧口径（不过滤）会把陈旧行也算成待办，复核人于是被叫去
  // 替换一条交付材料里根本没有的地址（实测修复前全平台 4 条失效待办里 3 条是这种）。
  // 这里不是自证其说：断言的是「新口径的每条都在引用清单里」且「两种口径在真实数据上确实不同」。
  const deadAll = lcRows.filter((r) => linkVerdict(r) === "dead").map((r) => r.url);
  const deadLive = lcLive.filter((r) => linkVerdict(r) === "dead").map((r) => r.url);
  if (deadAll.length !== deadLive.length) lcDiverged += 1;
  for (const u of deadLive) {
    checks += 1;
    if (!citeUrls.has(u)) failures.push(`${taskId.slice(0, 8)} 待办里的失效链接不在当前引用清单中：${u}`);
  }
  for (const u of deadAll.filter((x) => !citeUrls.has(x))) {
    checks += 1;
    if (deadLive.includes(u)) failures.push(`${taskId.slice(0, 8)} 陈旧失效行漏进了待办：${u}`);
  }
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
  // 结论里已标注「未取得公开原文，仅作背景参考」的文号：与结果页、看板、台账同一份判据
  const labeledTexts = labeledDocRefTexts([...tr.untraced, ...tr.unverifiableRefs], text);
  const labeled = [...tr.untraced, ...tr.unverifiableRefs].filter((r) => labeledTexts.has(r.text)).length;
  const amounts = traceAmounts(
    text,
    calls.map((c) => c.result),
    task.instruction ?? "",
    calls.filter((c) => TEXT_AMOUNT_TOOLS.has(c.toolName)).map((c) => c.result),
  );
  const acked = new Set(listAmountChecks(taskId).map((c) => c.key));
  const amountPending = amounts.untraced.filter((u) => !acked.has(amountKey(u))).length;
  // 与台账、任务页同一口径：检索结果池不按 ok 过滤（服务端 stats.ts 也是这么算的）
  const amountSplit = classifyUntraced(
    amounts.untraced.filter((u) => !acked.has(amountKey(u))),
    calls.filter((c) => SEARCH_TOOL_NAMES.has(c.toolName)).map((c) => c.result),
  );
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
  // 两类弱证据不算待办也不算欠账（与结果页、台账、服务端候选清单同源）：结论里已写明「仅作背景参考，
  // 不作为政策依据」的，以及只在检索留存里、从未进入结论正文的
  const disclaimed = disclaimedWeakUrls(cites, text);
  const settled = settledWeakUrls(cites, text);
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
    offTopicCitations: offTopicCitationTitles(cites, text),
    searches: se.calls > 0 ? se : null,
    linkCheck: lcAt ? lcSum : null,
    linkCheckAgeHours: ageHours(lcAt),
    amountTotal: amounts.total,
    amountUntraced: amountPending,
    amountPendingWeb: amountSplit.web.length,
    amountPendingUnexplained: amountSplit.unexplained.length,
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
      labeled,
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
      disclaimed: disclaimed.size,
      uncited: Math.max(0, settled.size - disclaimed.size),
    },
    citationChecks: citeSum,
    linkCheck: lcAt ? { ...lcSum, checkedAt: lcAt } : null,
    searches: se.calls > 0 ? { calls: se.calls, withUrls: se.withUrls, metadataOnly: se.metadataOnly, dropped: sf.dropped } : null,
    amounts: {
      total: amounts.total,
      traced: amounts.traced,
      fromInput: amounts.fromInput,
      pending: amountPending,
      acked: amounts.untraced.length - amountPending,
      pendingWeb: amountSplit.web.length,
      pendingUnexplained: amountSplit.unexplained.length,
    },
    revision: rev,
    todos: {
      docRefs: targets.filter((t) => !matchedDocs.has(t.key) && !labeledTexts.has(t.text)).map((t) => t.text),
      weakCitations: weak
        .filter((c) => !replaced.has(refKey("citation", c.url)) && !settled.has(c.url))
        .map((c) => `${c.title} ${c.url}`),
      // 与结果页同一份 liveChecks：只列地址仍在当前引用清单里的失效链接
      deadLinks: lcLive.filter((r) => linkVerdict(r) === "dead").map((r) => r.url),
    },
  };
}

let walked = 0;
let withTodos = 0;
let disclaimedTotal = 0;
let uncitedTotal = 0;
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
  // 待办清单可能比待处置数多（上一版结论留下的 matched 记录不再对应当前文号），但不能更少。
  // 比的是 pending - labeled：已在结论中标注「未取得公开原文」的不进待办（实测 aabd138a 三处全部
  // 标注后待办为 0，若仍按 pending 比就会报「3 处多于 0 项」的假警）
  const docOpen = input.docRefs.pending - (input.docRefs.labeled ?? 0);
  if (docOpen > input.todos.docRefs.length) {
    failures.push(
      `${t.id.slice(0, 8)} 待处置文号 ${docOpen} 处，多于待办清单的 ${input.todos.docRefs.length} 项`,
    );
  }
  const text2 = evidenceSheetMarkdown(input).join("\n");
  checks += 1;
  if (!rs.every((r) => text2.includes(r.item))) failures.push(`${t.id.slice(0, 8)} MD 缺少核对项`);
  // 已声明为背景参考的条数必须在核对表里说出来：否则读者只看到「证据力弱 N 条」，会以为全都等着处置
  checks += 1;
  // 汇总口径与平台看板一致：没有结论的任务不计证据欠账（它没有可交付物，弱证据也就无处可处置），
  // 否则这行日志会比看板多出几条，两处数字对不上又要花时间解释
  if (String(getTask(t.id)?.result ?? "").trim() !== "") {
    disclaimedTotal += input.citations.disclaimed ?? 0;
    uncitedTotal += input.citations.uncited ?? 0;
  }
  if ((input.citations.disclaimed ?? 0) > 0 && !text2.includes("已在结论中声明为背景参考")) {
    failures.push(`${t.id.slice(0, 8)} 有 ${input.citations.disclaimed} 条弱证据已声明为背景参考，核对表未写明`);
  }
}
ok("真实任务全部能生成核对表", walked > 0, `实际 ${walked} 个`);
// 防空跑：链接核验这一项与失效链接这一组待办，必须真的被真实数据走过
ok("确实走到了带链接核验记录的任务", lcTasks >= 1, `实际 ${lcTasks} 个`);
ok("确实读到了核验行", lcRowsTotal >= 1, `实际 ${lcRowsTotal} 行`);
ok(
  "确实遇到了陈旧行（地址已不在引用清单里）——否则「过滤」这一步等于没验",
  lcStaleTotal >= 1,
  `实际 ${lcStaleTotal} 行`,
);
ok(
  "确实有任务的待办条数因这道过滤而改变——否则断言的是空差异",
  lcDiverged >= 1,
  `实际 ${lcDiverged} 个任务`,
);
console.log(
  `[verify] 真实任务走查：${walked} 个任务生成核对表，其中 ${withTodos} 个仍有交付前待办，${disclaimedTotal} 条弱证据已在结论中声明为背景参考、${uncitedTotal} 条未进入结论正文`,
);
console.log(
  `[verify] 链接核验走查：${lcTasks} 个任务共 ${lcRowsTotal} 行核验记录，其中 ${lcStaleTotal} 行地址已不在当前引用清单里（按判据不计入汇总、不进待办、不进交付 MD 明细）`,
);

console.log(`[verify] 证据核对表检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 证据核对表规则不符");
  process.exit(1);
}
console.log("[PASS] 证据核对表正确（九项结论 / 空输入兜底 / 待办分组 / MD 片段 / 真实任务走查）");
