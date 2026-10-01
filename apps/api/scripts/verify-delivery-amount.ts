/**
 * 验证脚本：交付 MD「结论金额溯源」节（列结构 / 两类拆分 / 处置建议 / 截断提示 / 已核对表）。
 * 运行：pnpm verify:delivamount
 *
 * 真实任务走查放在 verify:manifest 里（那边已经把 amounts / 待确认清单 / 两类拆分都组装好了，
 * 再抄一份取数就是第三处口径），这里负责纯函数级的形状断言：喂假数据，逐列逐行验。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { amountSection, AMOUNT_TABLE_LIMIT, ORIGIN_ADVICE } from "../../web/src/delivery-amount.ts";
import { classifyUntraced, UNTRACED_ORIGIN_TEXT, type Amount } from "../../web/src/amount-trace.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

const cells = (line: string): number => line.split("|").length - 2;
function tableAfter(lines: string[], header: string): string[] {
  const at = lines.indexOf(header);
  if (at < 0) return [];
  const out: string[] = [];
  for (let i = at + 2; i < lines.length; i++) {
    const l = lines[i];
    if (!l || !l.startsWith("|")) break;
    out.push(l);
  }
  return out;
}

const HEADER = "| # | 金额 | 结论中的上下文 | 类别 | 处理建议 |";
const mk = (raw: string, cents: number, context: string): Amount =>
  ({ raw, match: raw, cents, context, index: 0, occurrences: 1 }) as unknown as Amount;

// 1) 两类各造几处：引自联网正文 / 三处均无出处
const WEB_RESULTS = [{ retainedText: "政策原文提到 100,000.00 元与 200,000.00 元" }];
const PENDING = [
  mk("100,000.00", 10000000, "限额 100,000.00 元"),
  mk("200,000.00", 20000000, "结转 200,000.00 元"),
  mk("999,999.00", 99999900, "推算 999,999.00 元"),
];
const split = classifyUntraced(PENDING, WEB_RESULTS);
expect("确实造出了两类（不是全落在一类里）", [split.web.length > 0, split.unexplained.length > 0], [true, true]);
expect("两类之和等于待确认总数", split.web.length + split.unexplained.length, PENDING.length);

const sec = amountSection({
  total: 10,
  traced: 6,
  fromInput: 1,
  pending: PENDING,
  split,
  ackedCount: 0,
  acked: [],
});
expect("节标题是「结论金额溯源」", sec[0], "## 结论金额溯源");
const head = sec.find((l) => l.startsWith("- 结论中识别出金额")) ?? "";
expect("首行报出四项计数", head.includes("金额 10 处") && head.includes("可溯源 6 处"), true);
expect("首行报出待确认与已核对", head.includes("待人工确认 3 处"), true);
expect("首行把待确认按两类拆开", head.includes(`引自联网正文 ${split.web.length} 处`), true);
expect("首行的另一类也拆开报", head.includes(`三处均无出处 ${split.unexplained.length} 处`), true);
expect("待确认表存在且是 5 列", sec.includes(HEADER), true);
expect("表头 5 列", cells(HEADER), 5);
expect("分隔行也是 5 列", cells(sec[sec.indexOf(HEADER) + 1] ?? ""), 5);
const rows = tableAfter(sec, HEADER);
expect("表行数与待确认处数一致", rows.length, PENDING.length);
for (const r of rows) expect(`每行 5 个单元格：${r.slice(0, 24)}…`, cells(r), 5);
// 类别列与处理建议列必须成对出现，且用的是同一份文案常量
for (const kind of ["web", "unexplained"] as const) {
  const some = rows.filter((r) => r.includes(UNTRACED_ORIGIN_TEXT[kind]));
  expect(`类别「${UNTRACED_ORIGIN_TEXT[kind]}」确实出现在表里`, some.length > 0, true);
  for (const r of some) {
    expect(`「${UNTRACED_ORIGIN_TEXT[kind]}」那一行配的是它自己的处置建议`, r.includes(ORIGIN_ADVICE[kind]), true);
  }
}
expect(
  "表后给出两类之和的配平行（复核人能自己对账）",
  sec.some((l) => l.startsWith("- 两类之和 3 处 = 待人工确认 3 处")),
  true,
);
expect("两类处置建议不是同一句话", ORIGIN_ADVICE.web !== ORIGIN_ADVICE.unexplained, true);

// 2) 超出上限不静默截断
const MANY = Array.from({ length: AMOUNT_TABLE_LIMIT + 3 }, (_, i) =>
  mk(`${(i + 1) * 1000}.00`, (i + 1) * 100000, `第 ${i + 1} 笔 ${(i + 1) * 1000}.00 元`),
);
const manySec = amountSection({
  total: MANY.length,
  traced: 0,
  fromInput: 0,
  pending: MANY,
  split: classifyUntraced(MANY, []),
  ackedCount: 0,
  acked: [],
});
expect("确实造出了超过上限的待确认清单", MANY.length > AMOUNT_TABLE_LIMIT, true);
expect("表最多列上限条", tableAfter(manySec, HEADER).length, AMOUNT_TABLE_LIMIT);
expect("超出上限时如实说明还有几处没列", manySec.some((l) => l.includes("另有 3 处待人工确认的金额未列出")), true);

// 3) 空态：没有待确认金额时不写两类拆分、不填占位数字
const emptySec = amountSection({
  total: 4,
  traced: 4,
  fromInput: 0,
  pending: [],
  split: classifyUntraced([], []),
  ackedCount: 0,
  acked: [],
});
expect("空态说明照实写", emptySec.some((l) => l.includes("没有待人工确认的金额")), true);
expect("空态不出待确认表", emptySec.includes(HEADER), false);
expect("空态不写两类拆分（不填占位数字）", emptySec.join("\n").includes("引自联网正文"), false);

// 4) 已人工核对表
const ackedSec = amountSection({
  total: 5,
  traced: 3,
  fromInput: 0,
  pending: [],
  split: classifyUntraced([], []),
  ackedCount: 2,
  acked: [
    { raw: "1,000.00", occurrences: 2, at: "2026-10-01T10:00:00.000Z", note: "已对过底稿" },
    { raw: "2,000.00", occurrences: 1, at: "2026-10-01T11:00:00.000Z", note: "" },
  ],
});
expect("已核对小节存在", ackedSec.includes("### 已人工核对"), true);
const ackedRows = tableAfter(ackedSec, "| # | 金额 | 出现处数 | 核对时间 | 备注 |");
expect("已核对表列出每一条", ackedRows.length, 2);
expect("备注为空时写「（无）」而不是留空格", ackedRows[1]?.includes("（无）"), true);
expect("首行报出已人工核对处数", (ackedSec.find((l) => l.startsWith("- 结论中识别出金额")) ?? "").includes("已人工核对 2 处"), true);

// 5) 同源：组件里只调用一次，且不再自己拼这一节
const here = path.dirname(fileURLToPath(import.meta.url));
const bench = fs.readFileSync(
  path.resolve(here, "..", "..", "web", "src", "components", "TaskWorkbench.tsx"),
  "utf8",
);
expect("组件里只调用这一节一次（没有第二份实现）", bench.split("amountSection(").length - 1, 1);
expect("组件里不再自己拼这一节的标题", bench.includes('"## 结论金额溯源"'), false);
expect("待确认表的上限没有在组件里被写死", /amountPending\.slice\(0,\s*\d+\)/.test(bench), false);

console.log(`[verify] 交付 MD 金额溯源节检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 交付 MD「结论金额溯源」节不符");
  process.exit(1);
}
console.log("[PASS] 交付 MD「结论金额溯源」节正确（列结构 / 两类拆分 / 处置建议 / 截断提示 / 已核对表）");
