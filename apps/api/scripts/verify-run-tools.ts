/**
 * 验证脚本：工具调用清单（按运行分组 / 入参摘要 / 耗时 / 汇总）。
 * 运行：pnpm verify:rtools
 */
import {
  callStats,
  callsByRun,
  durationMs,
  fmtDuration,
  mdCell,
  summarizeArgs,
  type CallRow,
} from "../../web/src/run-tools.ts";
import { runWindows } from "../../web/src/run-artifacts.ts";

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

console.log(`[verify] 工具调用清单检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 工具调用清单规则不符");
  process.exit(1);
}
console.log("[PASS] 工具调用清单规则正确（分组 / 摘要 / 耗时 / 汇总）");
