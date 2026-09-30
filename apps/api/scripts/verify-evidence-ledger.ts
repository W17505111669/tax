/**
 * 验证脚本：全平台证据核对台账（排序与合计 / 单元格与列序 / CSV 与 Markdown 导出 / 与平台统计口径交叉核对）。
 * 运行：pnpm verify:ledger
 */
import {
  csvField,
  CSV_BOM,
  ledgerCells,
  ledgerCsv,
  ledgerMarkdown,
  ledgerSort,
  ledgerTotals,
  LEDGER_COLUMNS,
  rowGap,
  type LedgerRow,
} from "../../web/src/evidence-ledger.ts";
import { computePlatformStats } from "../src/services/stats.ts";
import { getTask } from "../src/services/task-store.ts";
import { db } from "../src/db.ts";
import { CSV_EOL } from "../../web/src/csv.ts";

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

const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  taskId: "t1",
  title: "示例任务",
  agentId: "rd-audit",
  status: "completed",
  docRefTotal: 4,
  docRefTraced: 2,
  docRefPending: 1,
  docRefLabeled: 0,
  docRefMatched: 1,
  docRefTracedByRecheck: 1,
  citations: 6,
  official: 3,
  weak: 2,
  weakDisclaimed: 0,
  weakUncited: 0,
  replaced: 1,
  searchCalls: 3,
  searchMetadataOnly: 1,
  searchDropped: 5,
  amountTotal: 10,
  amountPending: 2,
  amountPendingWeb: 2,
  amountPendingUnexplained: 0,
  revision: null,
  ...over,
});

// 1) 欠账与排序
expect("欠账 = 弱证据 + 待复查文号", rowGap(row()), 3);
expect("没有欠账", rowGap(row({ weak: 0, docRefPending: 0 })), 0);
// 结论里已写明「仅作背景参考，不作为政策依据」的弱证据不是欠账：再催替换只是噪音，
// 实测一个任务 14 条弱证据里 8 条属于这种，虚报成一倍多
expect("已声明为背景参考的弱证据不算欠账", rowGap(row({ weak: 3, weakDisclaimed: 3, docRefPending: 0 })), 0);
expect("只声明了一部分时按剩下待处置的算", rowGap(row({ weak: 5, weakDisclaimed: 2, docRefPending: 1 })), 4);
expect("声明数超过弱证据数也不会算出负欠账", rowGap(row({ weak: 1, weakDisclaimed: 4, docRefPending: 0 })), 0);
// 只在检索留存里、从未进入结论正文的弱证据同样不是欠账：不是这份交付材料的依据，也没处补标注
expect("未进结论正文的弱证据不算欠账", rowGap(row({ weak: 4, weakUncited: 4, docRefPending: 0 })), 0);
// 结论里已标注「未取得公开原文，仅作背景参考」的文号同样不算欠账：查不到原文时如实标注就是设计好的收口
expect("已标注为背景参考的文号不算欠账", rowGap(row({ weak: 0, docRefPending: 3, docRefLabeled: 3 })), 0);
expect("只标注了一部分时按剩下的算", rowGap(row({ weak: 0, docRefPending: 5, docRefLabeled: 2 })), 3);
expect("标注数超过待复查数也不会算出负欠账", rowGap(row({ weak: 0, docRefPending: 1, docRefLabeled: 4 })), 0);
expect(
  "两类都不算欠账时只剩待复查文号",
  rowGap(row({ weak: 6, weakDisclaimed: 2, weakUncited: 3, docRefPending: 1 })),
  2,
);
expect(
  "弱证据全部声明且无待复查文号的任务不算欠账任务",
  ledgerTotals([row({ weak: 3, weakDisclaimed: 3, docRefPending: 0 })]).withGaps,
  0,
);
expect(
  "弱证据全部未进结论正文的任务也不算欠账任务",
  ledgerTotals([row({ weak: 3, weakUncited: 3, docRefPending: 0 })]).withGaps,
  0,
);
expect(
  "文号全部已标注的任务不算欠账任务",
  ledgerTotals([row({ weak: 0, docRefPending: 3, docRefLabeled: 3 })]).withGaps,
  0,
);
const unsorted = [
  row({ taskId: "a", title: "欠账少", weak: 1, docRefPending: 0 }),
  row({ taskId: "b", title: "欠账多", weak: 5, docRefPending: 2 }),
  row({ taskId: "c", title: "无欠账", weak: 0, docRefPending: 0 }),
];
expect(
  "按欠账倒序",
  ledgerSort(unsorted).map((r) => r.taskId),
  ["b", "a", "c"],
);
expect("排序不改动入参", unsorted.map((r) => r.taskId), ["a", "b", "c"]);
expect(
  "欠账相同按作品与标题",
  ledgerSort([
    row({ taskId: "z", title: "B任务", agentId: "rd-audit", weak: 1 }),
    row({ taskId: "y", title: "A任务", agentId: "rd-audit", weak: 1 }),
    row({ taskId: "x", title: "C任务", agentId: "land-vat", weak: 1 }),
  ]).map((r) => r.taskId),
  ["x", "y", "z"],
);

// 2) 合计
const t = ledgerTotals([
  row({
    taskId: "a",
    weak: 2,
    weakDisclaimed: 2,
    weakUncited: 0,
    docRefPending: 1,
    docRefTracedByRecheck: 1,
    citations: 6,
    official: 3,
    replaced: 1,
    revision: "证据质量改善",
  }),
  row({
    taskId: "b",
    weak: 0,
    docRefPending: 0,
    docRefTracedByRecheck: 0,
    citations: 2,
    official: 2,
    replaced: 0,
    revision: "证据质量退步，请核对本次修订",
  }),
  row({ taskId: "c", weak: 1, docRefPending: 0, docRefTracedByRecheck: 2, citations: 0, official: 0, replaced: 0, revision: null }),
]);
expect("任务数", t.tasks, 3);
expect("弱证据合计", t.weak, 3);
expect("已声明背景参考合计", t.weakDisclaimed, 2);
expect("未进结论正文合计", t.weakUncited, 0);
expect("引用合计", t.citations, 8);
expect("官方原文合计", t.official, 5);
expect("替代来源就绪合计", t.replaced, 1);
expect("待复查文号合计", t.docRefPending, 1);
expect("已标注文号合计", t.docRefLabeled, 0);
expect("复查取得出处合计", t.docRefTracedByRecheck, 3);
expect("欠账任务数", t.withGaps, 2);
expect("修订可比任务数", t.revisionCompared, 2);
expect("修订改善任务数", t.revisionImproved, 1);
expect("空台账合计", ledgerTotals([]).tasks, 0);
expect("逐项求和（检索与金额）", [t.searchCalls, t.searchMetadataOnly, t.searchDropped, t.amountTotal, t.amountPending], [9, 3, 15, 30, 6]);

// 3) 单元格与列序
// 按列名取下标：新增或调整列时断言不会静默错位（此前硬编码下标就因为插入「其中复查取得」整段偏移）
const cell = (
  r: LedgerRow,
  col: (typeof LEDGER_COLUMNS)[number],
  name: (id: string) => string = (x) => x,
): string => ledgerCells(r, name)[LEDGER_COLUMNS.indexOf(col)]!;

expect("列数与表头一致", ledgerCells(row(), (x) => x).length, LEDGER_COLUMNS.length);
// 界面按列名给欠账两列上色，列名一改就会静默失去高亮：这里替它盯着
expect(
  "欠账相关列的列名仍在表头里",
  (["待复查", "已标注未取得原文", "证据力弱", "已声明背景参考", "未进结论正文"] as const).every((c) =>
    (LEDGER_COLUMNS as readonly string[]).includes(c),
  ),
  true,
);
expect("已标注文号单独成列", cell(row({ docRefLabeled: 2 }), "已标注未取得原文"), "2");
expect("已声明条数单独成列", cell(row({ weakDisclaimed: 2 }), "已声明背景参考"), "2");
expect("未进结论条数单独成列", cell(row({ weakUncited: 3 }), "未进结论正文"), "3");
expect("文号列写成 有出处/总数", cell(row(), "文号 有出处/总数"), "2/4");
expect("复查取得单独成列", cell(row(), "其中复查取得"), "1");
expect("金额列写成 待确认/总数", cell(row(), "金额 待确认/总数"), "2/10");
expect("修订影响为空时用破折号", cell(row(), "修订影响"), "—");
expect("修订影响原样透出", cell(row({ revision: "证据质量改善" }), "修订影响"), "证据质量改善");
expect("作品名走传入的映射", cell(row(), "作品", () => "智研税审"), "智研税审");

// 4) CSV 导出与转义
expect("普通字段不加引号", csvField("示例任务"), "示例任务");
expect("含逗号加引号", csvField("a,b"), '"a,b"');
expect("含引号翻倍", csvField('a"b'), '"a""b"');
expect("含换行加引号", csvField("a\nb"), '"a\nb"');
const csv = ledgerCsv([row({ title: "含,逗号的任务" }), row({ taskId: "t2", title: "第二个任务" })]);
const csvLines = csv.split(CSV_EOL);
expect("CSV 行数 = 表头 + 数据 + 合计", csvLines.length, 4);
expect("CSV 表头列数", csvLines[0]!.split(",").length, LEDGER_COLUMNS.length);
ok("CSV 转义含逗号的标题", csvLines.some((l) => l.includes('"含,逗号的任务"')), csv.slice(0, 120));
ok("CSV 含合计行", csvLines[csvLines.length - 1]!.startsWith("合计（2 个任务）"), csvLines[csvLines.length - 1] ?? "");
expect("BOM 常量可用于 Excel", CSV_BOM.charCodeAt(0), 0xfeff);
expect("空台账也能导出", ledgerCsv([]).split(CSV_EOL).length, 2);
expect("台账 CSV 用 CRLF 分行（Excel 与记事本一致）", ledgerCsv([]).includes(CSV_EOL), true);

// 5) Markdown 导出
const md = ledgerMarkdown([row(), row({ taskId: "t2", title: "第二个任务", weak: 9 })], (x) => x, "2026-09-29 10:00");
const mdText = md.join("\n");
expect("以 H1 开头", md[0], "# 全平台证据核对台账");
ok("含生成时间", mdText.includes("生成时间：2026-09-29 10:00"));
ok("不传生成时间时不出现该行", !ledgerMarkdown([row()]).join("\n").includes("生成时间"));
ok("含表头", mdText.includes(`| ${LEDGER_COLUMNS.join(" | ")} |`));
ok("含分隔行", mdText.includes(`| ${LEDGER_COLUMNS.map(() => "---").join(" | ")} |`));
expect(
  "表格行数 = 表头 + 2 个任务 + 合计",
  md.filter((l) => l.startsWith("| ") && !l.includes("---")).length,
  4,
);
ok("欠账多的排在前面", mdText.indexOf("第二个任务") < mdText.indexOf("示例任务"), "行序");
ok("含合计行", mdText.includes("**合计（2 个任务）**"));
ok("含口径说明", mdText.includes("口径说明：") && mdText.includes("证据力弱」指引用指向门户首页"));
ok("含汇总数字", mdText.includes("任务数：2") && mdText.includes("仍有证据欠账的任务：2"));

// 6) 与平台统计口径交叉核对：台账逐行求和必须等于看板的汇总数字
const s = computePlatformStats();
const ev = s.evidence;
const led = ev.ledger;
const taskCount = (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
expect("台账行数等于任务数", led.length, taskCount);
expect("台账行数等于统计的任务数", led.length, s.tasks);
const sum = (f: (r: LedgerRow) => number) => led.reduce((a, r) => a + f(r), 0);
expect("引用合计与看板一致", sum((r) => r.citations), ev.citations);
expect("官方原文合计与看板一致", sum((r) => r.official), ev.officialCitations);
expect("弱证据合计与看板一致", sum((r) => r.weak), ev.weakCitations);
expect("已声明背景参考合计与看板一致", sum((r) => r.weakDisclaimed), ev.weakDisclaimed);
expect("未进结论正文合计与看板一致", sum((r) => r.weakUncited), ev.weakUncited);
expect("已声明数不超过弱证据数", sum((r) => r.weakDisclaimed) <= sum((r) => r.weak), true);
expect(
  "已声明与未进结论两类不重叠，加起来不超过弱证据总数",
  sum((r) => r.weakDisclaimed) + sum((r) => r.weakUncited) <= sum((r) => r.weak),
  true,
);
expect("替代来源就绪合计与看板一致", sum((r) => r.replaced), ev.weakWithReplacement);
expect("待复查文号合计与看板一致", sum((r) => r.docRefPending), ev.docRefPending);
expect("已标注文号合计与看板一致", sum((r) => r.docRefLabeled), ev.docRefLabeled);
expect("已标注数不超过待复查数", sum((r) => r.docRefLabeled) <= sum((r) => r.docRefPending), true);
expect("复查到出处合计与看板一致", sum((r) => r.docRefMatched), ev.docRefMatched);
expect("文号总数合计与看板一致", sum((r) => r.docRefTotal), ev.docRefs);
expect("文号可溯源合计与看板一致", sum((r) => r.docRefTraced), ev.docRefTraced);
expect("复查取得出处合计与看板一致", sum((r) => r.docRefTracedByRecheck), ev.docRefTracedByRecheck);
expect("检索调用合计与看板一致", sum((r) => r.searchCalls), ev.searchCalls);
expect("仅元数据检索合计与看板一致", sum((r) => r.searchMetadataOnly), ev.searchMetadataOnly);
expect("欠账任务数与缺口清单一致", ledgerTotals(led).withGaps, ev.gaps.length);
// 没有结论就没有可交付物，也就没有证据欠账。实测失败任务「映射模式填列验证」（结论为空）
// 曾带着 5 条引用、4 条弱证据进台账与缺口清单——引用是从工具留存结果提取的，失败任务照样有；
// 但它们从未进入任何结论，替代来源也因为「没有结论就没有主题」而永远判不出 matched。
const noConclusion = led.filter((r) => String(getTask(r.taskId)?.result ?? "").trim() === "");
expect(
  "无结论的任务不计引用与弱证据",
  noConclusion.every(
    (r) =>
      r.citations === 0 && r.weak === 0 && r.replaced === 0 && r.weakDisclaimed === 0 && r.weakUncited === 0,
  ),
  true,
);
expect(
  "无结论的任务不进缺口清单",
  noConclusion.every((r) => !ev.gaps.some((g) => g.id === r.taskId)),
  true,
);
ok(
  "无结论不等于没有检索活动：这类任务的检索次数照实保留",
  noConclusion.length === 0 || noConclusion.some((r) => r.searchCalls > 0),
);
console.log(`[verify] 台账中无结论的任务 ${noConclusion.length} 个（不计证据欠账，检索活动照实计入）`);
expect(
  "欠账任务的缺口构成一致",
  ev.gaps.every((g) => {
    const r = led.find((x) => x.taskId === g.id);
    return (
      r !== undefined &&
      r.weak === g.weakCitations &&
      r.weakDisclaimed === g.weakDisclaimed &&
      r.weakUncited === g.weakUncited &&
      r.docRefPending === g.docRefPending &&
      r.docRefLabeled === g.docRefLabeled
    );
  }),
  true,
);
expect("台账已按欠账倒序", led.every((r, i) => i === 0 || rowGap(led[i - 1]!) >= rowGap(r)), true);
expect(
  "每行的分级不超过引用数",
  led.every((r) => r.official <= r.citations && r.weak <= r.citations && r.replaced <= r.weak),
  true,
);
expect(
  "每行的文号口径自洽",
  led.every(
    (r) =>
      r.docRefTraced <= r.docRefTotal &&
      r.docRefPending <= r.docRefTotal &&
      r.docRefMatched >= 0 &&
      // 复查取得的出处已计入 traced，两个数不能再各扣一遍：有出处 + 待复查 恒等于总数
      r.docRefTraced + r.docRefPending === r.docRefTotal &&
      r.docRefTracedByRecheck <= r.docRefTraced,
  ),
  true,
);
expect("每行都有任务标题", led.every((r) => r.title.length > 0), true);
expect("台账导出行数 = 表头 + 任务 + 合计", ledgerCsv(led).split(CSV_EOL).length, led.length + 2);
ok(
  "台账 MD 含全部任务标题",
  led.every((r) => ledgerMarkdown(led).join("\n").includes(r.title.slice(0, 12))),
);
console.log(
  `[verify] 真实台账：${led.length} 行 · 欠账任务 ${ledgerTotals(led).withGaps} 个 · 文号 ${sum((r) => r.docRefTraced)}/${sum(
    (r) => r.docRefTotal,
  )} 有出处 · 引用 ${sum((r) => r.citations)} 条（官方 ${sum((r) => r.official)} · 弱 ${sum((r) => r.weak)}）· 金额待确认 ${sum(
    (r) => r.amountPending,
  )} 处`,
);

// N) 金额待确认按「为什么找不到出处」拆成两类：不拆开的话，检索类任务摘引政策原文产生的大批量
// 待确认会把真正要拦的「疑似口算」淹掉（实测两个检索类任务 23 处待确认全部来自联网正文、疑似口算 0 处）
const AMT_COL = LEDGER_COLUMNS.indexOf("金额 待确认/总数");
ok("台账有「金额 待确认/总数」列", AMT_COL >= 0);
expect(
  "该列之后紧跟两列拆分",
  LEDGER_COLUMNS.slice(AMT_COL + 1, AMT_COL + 3),
  ["其中引自联网正文", "其中三处均无出处"],
);
const splitRows = [
  row({ taskId: "a", amountTotal: 12, amountPending: 12, amountPendingWeb: 12, amountPendingUnexplained: 0 }),
  row({ taskId: "b", amountTotal: 5, amountPending: 1, amountPendingWeb: 0, amountPendingUnexplained: 1 }),
];
const splitTotals = ledgerTotals(splitRows);
expect(
  "两类分别求和且之和等于待确认合计",
  [splitTotals.amountPendingWeb, splitTotals.amountPendingUnexplained, splitTotals.amountPending],
  [12, 1, 13],
);
expect("两类之和恒等于待确认合计", splitTotals.amountPendingWeb + splitTotals.amountPendingUnexplained, splitTotals.amountPending);
const splitCells = ledgerCells(splitRows[0]!, (x) => x);
expect("每行列数与表头一致（新增两列后没有错位）", splitCells.length, LEDGER_COLUMNS.length);
expect(
  "拆分列的值落在对应位置",
  [splitCells[LEDGER_COLUMNS.indexOf("其中引自联网正文")], splitCells[LEDGER_COLUMNS.indexOf("其中三处均无出处")]],
  ["12", "0"],
);
// ledgerMarkdown 返回的是行数组，不是拼好的字符串
const splitMd = ledgerMarkdown(splitRows).join("\n");
ok("台账 MD 给出两类拆分数字", splitMd.includes("引自联网正文 12 处") && splitMd.includes("三处均无出处 1 处"));
ok(
  "台账 MD 写清两类含义不同（否则读的人会把它们当同一件事）",
  splitMd.includes("引用抄得准不准") && splitMd.includes("模型可能口算"),
);
ok("台账 CSV 也带两列拆分", ledgerCsv(splitRows).includes("其中引自联网正文") && ledgerCsv(splitRows).includes("其中三处均无出处"));
// 真实数据：每行两类之和必须等于该行待确认数，否则说明统计侧漏算了一类
const realRows = computePlatformStats().evidence.ledger;
expect(
  "真实台账每行两类之和等于该行待确认数",
  realRows.filter((r) => r.amountPendingWeb + r.amountPendingUnexplained !== r.amountPending).map((r) => r.taskId.slice(0, 8)),
  [],
);
const realTotals = ledgerTotals(realRows);
console.log(
  `[verify] 真实台账金额待确认 ${realTotals.amountPending} 处：引自联网正文 ${realTotals.amountPendingWeb} · 三处均无出处 ${realTotals.amountPendingUnexplained}`,
);

console.log(`[verify] 证据台账检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 证据核对台账规则不符");
  process.exit(1);
}
console.log("[PASS] 证据核对台账正确（排序合计 / 单元格与列序 / CSV 与 MD 导出 / 与平台统计口径一致）");
