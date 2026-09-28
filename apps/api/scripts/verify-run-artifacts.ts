/**
 * 验证脚本：运行时间窗推导与产物归属（时间线导出「本次运行产物清单」的依据）。
 * 运行：pnpm verify:runart
 */
import {
  artifactsOfRun,
  fmtBytes,
  runWindows,
  unattributedArtifacts,
} from "../../web/src/run-artifacts.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

// 两次运行（第二次失败）+ 四份产物：运行前、运行 1 内、两次运行之间、运行 2 内
const items = [
  { kind: "task_created", at: "2026-09-28T08:00:00.000Z" },
  { kind: "run_started", at: "2026-09-28T08:01:00.000Z" },
  { kind: "tool_start", at: "2026-09-28T08:02:00.000Z" },
  { kind: "run_completed", at: "2026-09-28T08:03:00.000Z" },
  { kind: "run_started", at: "2026-09-28T08:10:00.000Z" },
  { kind: "tool_start", at: "2026-09-28T08:11:00.000Z" },
  { kind: "run_failed", at: "2026-09-28T08:12:00.000Z" },
];
const wins = runWindows(items);
expect("两次运行的时间窗", wins, [
  { run: 1, start: "2026-09-28T08:01:00.000Z", end: "2026-09-28T08:03:00.000Z" },
  { run: 2, start: "2026-09-28T08:10:00.000Z", end: "2026-09-28T08:12:00.000Z" },
]);

const arts = [
  { name: "before.xlsx", byteSize: 10, updatedAt: "2026-09-28T08:00:30.000Z" },
  { name: "run1.xlsx", byteSize: 7010, updatedAt: "2026-09-28T08:02:30.000Z" },
  { name: "between.xlsx", byteSize: 20, updatedAt: "2026-09-28T08:05:00.000Z" },
  { name: "run2.xlsx", byteSize: 12476, updatedAt: "2026-09-28T08:11:30.000Z" },
];
expect("第 1 次运行的产物", artifactsOfRun(arts, wins[0]).map((a) => a.name), ["run1.xlsx"]);
expect("第 2 次运行的产物", artifactsOfRun(arts, wins[1]).map((a) => a.name), ["run2.xlsx"]);
expect("未归属产物", unattributedArtifacts(arts, wins).map((a) => a.name), ["before.xlsx", "between.xlsx"]);
expect("不存在的运行序号返回空", artifactsOfRun(arts, undefined), []);
expect(
  "边界含端点（正好落在 end 上）",
  artifactsOfRun([{ name: "edge.xlsx", byteSize: 1, updatedAt: "2026-09-28T08:03:00.000Z" }], wins[0]).length,
  1,
);

// 没有结束事件（仍在执行）→ 区间开放，之后生成的产物都归这次运行
const openWins = runWindows([
  { kind: "run_started", at: "2026-09-28T09:00:00.000Z" },
  { kind: "tool_start", at: "2026-09-28T09:01:00.000Z" },
]);
expect("未结束运行 end 为 null", openWins, [{ run: 1, start: "2026-09-28T09:00:00.000Z", end: null }]);
expect(
  "开区间收纳之后生成的产物",
  artifactsOfRun([{ name: "late.xlsx", byteSize: 1, updatedAt: "2026-09-28T09:30:00.000Z" }], openWins[0]).length,
  1,
);

expect("无运行事件", runWindows([{ kind: "task_created", at: "2026-09-28T08:00:00.000Z" }]), []);
expect("空时间线", runWindows([]), []);
expect("字节格式化", [fmtBytes(0), fmtBytes(1023), fmtBytes(7010), fmtBytes(12476), fmtBytes(3 * 1024 * 1024)], [
  "0 B",
  "1023 B",
  "6.8 KB",
  "12.2 KB",
  "3.00 MB",
]);

console.log(`[verify] 运行产物归属检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 运行时间窗/产物归属规则不符");
  process.exit(1);
}
console.log("[PASS] 运行时间窗与产物归属规则正确（含开区间与未归属产物）");
