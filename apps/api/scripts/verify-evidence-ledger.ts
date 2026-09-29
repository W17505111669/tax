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
import { db } from "../src/db.ts";

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
  docRefMatched: 1,
  citations: 6,
  official: 3,
  weak: 2,
  replaced: 1,
  searchCalls: 3,
  searchMetadataOnly: 1,
  searchDropped: 5,
  amountTotal: 10,
  amountPending: 2,
  revision: null,
  ...over,
});

// 1) 欠账与排序
expect("欠账 = 弱证据 + 待复查文号", rowGap(row()), 3);
expect("没有欠账", rowGap(row({ weak: 0, docRefPending: 0 })), 0);
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
  row({ taskId: "a", weak: 2, docRefPending: 1, citations: 6, official: 3, replaced: 1, revision: "证据质量改善" }),
  row({ taskId: "b", weak: 0, docRefPending: 0, citations: 2, official: 2, replaced: 0, revision: "证据质量退步，请核对本次修订" }),
  row({ taskId: "c", weak: 1, docRefPending: 0, citations: 0, official: 0, replaced: 0, revision: null }),
]);
expect("任务数", t.tasks, 3);
expect("弱证据合计", t.weak, 3);
expect("引用合计", t.citations, 8);
expect("官方原文合计", t.official, 5);
expect("替代来源就绪合计", t.replaced, 1);
expect("待复查文号合计", t.docRefPending, 1);
expect("欠账任务数", t.withGaps, 2);
expect("修订可比任务数", t.revisionCompared, 2);
expect("修订改善任务数", t.revisionImproved, 1);
expect("空台账合计", ledgerTotals([]).tasks, 0);
expect("逐项求和（检索与金额）", [t.searchCalls, t.searchMetadataOnly, t.searchDropped, t.amountTotal, t.amountPending], [9, 3, 15, 30, 6]);

// 3) 单元格与列序
expect("列数与表头一致", ledgerCells(row(), (x) => x).length, LEDGER_COLUMNS.length);
expect(
  "文号列写成 有出处/总数",
  ledgerCells(row(), (x) => x)[3],
  "2/4",
);
expect(
  "金额列写成 待确认/总数",
  ledgerCells(row(), (x) => x)[13],
  "2/10",
);
expect("修订影响为空时用破折号", ledgerCells(row(), (x) => x)[14], "—");
expect("修订影响原样透出", ledgerCells(row({ revision: "证据质量改善" }), (x) => x)[14], "证据质量改善");
expect("作品名走传入的映射", ledgerCells(row(), () => "智研税审")[1], "智研税审");

// 4) CSV 导出与转义
expect("普通字段不加引号", csvField("示例任务"), "示例任务");
expect("含逗号加引号", csvField("a,b"), '"a,b"');
expect("含引号翻倍", csvField('a"b'), '"a""b"');
expect("含换行加引号", csvField("a\nb"), '"a\nb"');
const csv = ledgerCsv([row({ title: "含,逗号的任务" }), row({ taskId: "t2", title: "第二个任务" })]);
const csvLines = csv.split("\n");
expect("CSV 行数 = 表头 + 数据 + 合计", csvLines.length, 4);
expect("CSV 表头列数", csvLines[0]!.split(",").length, LEDGER_COLUMNS.length);
ok("CSV 转义含逗号的标题", csvLines.some((l) => l.includes('"含,逗号的任务"')), csv.slice(0, 120));
ok("CSV 含合计行", csvLines[csvLines.length - 1]!.startsWith("合计（2 个任务）"), csvLines[csvLines.length - 1] ?? "");
expect("BOM 常量可用于 Excel", CSV_BOM.charCodeAt(0), 0xfeff);
expect("空台账也能导出", ledgerCsv([]).split("\n").length, 2);

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
expect("替代来源就绪合计与看板一致", sum((r) => r.replaced), ev.weakWithReplacement);
expect("待复查文号合计与看板一致", sum((r) => r.docRefPending), ev.docRefPending);
expect("复查到出处合计与看板一致", sum((r) => r.docRefMatched), ev.docRefMatched);
expect("文号总数合计与看板一致", sum((r) => r.docRefTotal), ev.docRefs);
expect("文号可溯源合计与看板一致", sum((r) => r.docRefTraced), ev.docRefTraced);
expect("检索调用合计与看板一致", sum((r) => r.searchCalls), ev.searchCalls);
expect("仅元数据检索合计与看板一致", sum((r) => r.searchMetadataOnly), ev.searchMetadataOnly);
expect("欠账任务数与缺口清单一致", ledgerTotals(led).withGaps, ev.gaps.length);
expect(
  "欠账任务的缺口构成一致",
  ev.gaps.every((g) => {
    const r = led.find((x) => x.taskId === g.id);
    return r !== undefined && r.weak === g.weakCitations && r.docRefPending === g.docRefPending;
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
      r.docRefTraced + r.docRefPending <= r.docRefTotal,
  ),
  true,
);
expect("每行都有任务标题", led.every((r) => r.title.length > 0), true);
expect("台账导出行数 = 表头 + 任务 + 合计", ledgerCsv(led).split("\n").length, led.length + 2);
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

console.log(`[verify] 证据台账检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 证据核对台账规则不符");
  process.exit(1);
}
console.log("[PASS] 证据核对台账正确（排序合计 / 单元格与列序 / CSV 与 MD 导出 / 与平台统计口径一致）");
