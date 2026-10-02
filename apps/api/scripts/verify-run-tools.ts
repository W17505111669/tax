/**
 * 验证脚本：工具调用清单（按运行分组 / 入参摘要 / 耗时 / 汇总）。
 * 运行：pnpm verify:rtools
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  callStats,
  callsByRun,
  durationMs,
  fmtDuration,
  mdCell,
  summarizeArgs,
  toolCallSection,
  TOOL_TABLE_HEADER,
  type CallRow,
} from "../../web/src/run-tools.ts";
import { runWindows } from "../../web/src/run-artifacts.ts";
import { markdownTableCells } from "../../web/src/md-text.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

// 1) Markdown 安全化与入参摘要
expect("竖线转义", mdCell("a|b"), "a\\|b");
expect("换行压平", mdCell("a\nb\r\nc"), "a b c");
expect("空入参", summarizeArgs(null), "—");
expect("空对象入参", summarizeArgs({}), "{}");
expect("字符串入参原样", summarizeArgs("核查研发费用"), "核查研发费用");
expect("多行 JSON 压成单行", summarizeArgs({ a: 1, b: [2, 3] }), '{"a":1,"b":[2,3]}');
expect("超长截断并标注原长度", summarizeArgs("x".repeat(150), 100), `${"x".repeat(100)}…（共 150 字符）`);
expect("入参里的竖线被转义", summarizeArgs({ q: "a|b" }), '{"q":"a\\|b"}');

// 2) 耗时
expect("正常耗时", durationMs("2026-09-28T08:00:00.000Z", "2026-09-28T08:00:03.500Z"), 3500);
expect("未结束返回 null", durationMs("2026-09-28T08:00:00.000Z", null), null);
expect("结束早于开始返回 null", durationMs("2026-09-28T08:00:05.000Z", "2026-09-28T08:00:00.000Z"), null);
expect("不可解析返回 null", durationMs("不是时间", "2026-09-28T08:00:00.000Z"), null);
expect("耗时格式化", [fmtDuration(null), fmtDuration(320), fmtDuration(3500)], ["—", "320 ms", "3.5 s"]);

// 3) 按运行分组（时间窗与产物归属同源）
const wins = runWindows([
  { kind: "run_started", at: "2026-09-28T08:01:00.000Z" },
  { kind: "run_completed", at: "2026-09-28T08:03:00.000Z" },
  { kind: "run_started", at: "2026-09-28T08:10:00.000Z" },
  { kind: "run_failed", at: "2026-09-28T08:12:00.000Z" },
]);
const calls: CallRow[] = [
  { id: "c0", toolName: "prepare", at: "2026-09-28T08:00:00.000Z", endedAt: null, ok: null, args: {} },
  { id: "c1", toolName: "check_rd_expenses", at: "2026-09-28T08:02:00.000Z", endedAt: "2026-09-28T08:02:04.000Z", ok: true, args: { year: 2025 } },
  { id: "c2", toolName: "generate_workpaper", at: "2026-09-28T08:11:00.000Z", endedAt: "2026-09-28T08:11:02.000Z", ok: false, args: {} },
];
const grouped = callsByRun(calls, wins);
expect("运行窗口之外的调用归 0", (grouped.get(0) ?? []).map((c) => c.id), ["c0"]);
expect("第 1 次运行的调用", (grouped.get(1) ?? []).map((c) => c.id), ["c1"]);
expect("第 2 次运行的调用", (grouped.get(2) ?? []).map((c) => c.id), ["c2"]);
expect("没有调用时不产生分组", callsByRun([], wins).size, 0);
expect(
  "未结束运行收纳其后的调用",
  callsByRun([{ id: "late", toolName: "t", at: "2026-09-28T09:00:00.000Z", endedAt: null, ok: null, args: {} }], [
    { run: 1, start: "2026-09-28T08:50:00.000Z", end: null },
  ]).get(1)?.map((c) => c.id),
  ["late"],
);

// 4) 汇总
expect("调用汇总", callStats(calls), { total: 3, ok: 1, failed: 1, running: 1, avgMs: 3000 });
expect("空调用汇总", callStats([]), { total: 0, ok: 0, failed: 0, running: 0, avgMs: null });

// 5) 交付 MD「工具调用清单」节：此前拼行那段留在 TaskWorkbench 闭包里，本脚本只验得了纯函数，
//    节里的文本（合计行五个数字、分组表头、每行 6 列、行数合计）一条断言都没有。
const cells = (line: string): number => markdownTableCells(line).length;
const sec = toolCallSection(calls, wins);
expect("没有调用时只有一行兜底说明", toolCallSection([], wins), ["（本次任务没有工具调用记录）"]);
const head = sec.find((l) => l.startsWith("- 合计 ")) ?? "";
expect("合计行存在", head !== "", true);
expect(
  "合计行五个数字与 callStats 逐项一致",
  [...head.matchAll(/(\d+)/g)].map((m) => Number(m[1])).slice(0, 4),
  [3, 1, 1, 1],
);
expect("合计行写出平均耗时（不是空着）", head.includes(`平均耗时 ${fmtDuration(3000)}`), true);
expect("表头是 6 列", cells(TOOL_TABLE_HEADER), 6);
const headers = sec.filter((l) => l.startsWith("### "));
expect("分组数与 callsByRun 一致", headers.length, callsByRun(calls, wins).size);
expect("运行窗口之外那组有独立表头", headers.includes("### 运行窗口之外"), true);
expect(
  "其余分组表头写明第几次运行与起止时间",
  headers.filter((h) => h !== "### 运行窗口之外").every((h) => /^### 第 \d+ 次运行（.+ ~ .+）$/.test(h)),
  true,
);
let dataRows = 0;
let dashRows = 0;
for (let i = 0; i < sec.length; i++) {
  if (sec[i] !== TOOL_TABLE_HEADER) continue;
  expect(`分隔行也是 6 列（第 ${i} 行处）`, cells(sec[i + 1] ?? ""), 6);
  for (let j = i + 2; j < sec.length && (sec[j] ?? "").startsWith("|"); j++) {
    dataRows += 1;
    const row = sec[j] ?? "";
    expect(`每行 6 个单元格：${row.slice(0, 26)}…`, cells(row), 6);
    // markdownTableCells 不去首尾空格，按列比文案前必须 trim，否则判定全是 " 成功 " 这种带空格的串
    const cs = markdownTableCells(row).map((c) => c.trim());
    expect(`结果列只写三种判定：${cs[2]}`, ["成功", "失败", "执行中"].includes(cs[2] ?? ""), true);
    expect(`序号列是纯数字：${cs[0]}`, /^\d+$/.test(cs[0] ?? ""), true);
    expect(`开始时间列是 ISO 时间：${cs[4]}`, /^\d{4}-\d{2}-\d{2}T/.test(cs[4] ?? ""), true);
    // 未结束的调用算不出耗时，必须如实写破折号，不能编一个 0
    if (row.includes("prepare")) {
      dashRows += 1;
      expect("未结束的调用耗时写破折号", cs[3], "—");
    }
  }
}
expect("分组表行数合计等于调用总数（不丢行、不重复计行）", dataRows, calls.length);
expect("确实列出了多行（不是空表上通过的）", dataRows >= 3, true);
expect("确实走到了「未结束调用」那一行（防空跑）", dashRows >= 1, true);
expect(
  "入参摘要里的竖线被转义（否则表格串列）",
  toolCallSection(
    [{ id: "p", toolName: "t", at: "2026-09-28T08:02:00.000Z", endedAt: "2026-09-28T08:02:01.000Z", ok: true, args: { q: "a|b" } }],
    wins,
  ).some((l) => l.includes("a\\|b")),
  true,
);

// 6) 同源：组件里不再有第二份拼行实现
const here = path.dirname(fileURLToPath(import.meta.url));
const benchSrc = fs.readFileSync(
  path.resolve(here, "..", "..", "web", "src", "components", "TaskWorkbench.tsx"),
  "utf8",
);
expect("组件里只调用这一节一次", benchSrc.split("toolCallSection(").length - 1, 1);
expect("组件里不再自己拼合计行", benchSrc.includes("- 合计 ${st.total} 次调用"), false);
expect("组件里不再自己拼工具调用表头", benchSrc.includes('"| # | 工具 | 结果 | 耗时 | 开始时间 | 入参摘要 |"'), false);
const modSrc = fs.readFileSync(path.resolve(here, "..", "..", "web", "src", "run-tools.ts"), "utf8");
expect("模块里表头只有一处定义（组件与验证脚本都引它）", modSrc.split("| # | 工具 | 结果 | 耗时 | 开始时间 | 入参摘要 |").length - 1, 1);
console.log(`[verify] 工具调用清单检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 工具调用清单规则不符");
  process.exit(1);
}
console.log("[PASS] 工具调用清单规则正确（分组 / 摘要 / 耗时 / 汇总）");
