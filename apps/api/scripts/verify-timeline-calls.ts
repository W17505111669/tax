/**
 * 验证脚本：时间线 tool_start 事件与工具调用记录的配对。
 * 重点是「同名工具跨多次运行」时按次运行导出不会挂错入参/返回值。
 * 运行：pnpm verify:tlcalls
 */
import { matchToolCalls } from "../../web/src/timeline-calls.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

// 场景：两次运行都调用了 search_public_cases（续跑复核的典型形态）
const calls = [
  { id: "c1", toolName: "search_public_cases" },
  { id: "c2", toolName: "web_search" },
  { id: "c3", toolName: "search_public_cases" },
];
const items = [
  { kind: "run_started", payload: null },
  { kind: "tool_start", payload: { toolName: "search_public_cases", callId: "c1" } },
  { kind: "tool_start", payload: { toolName: "web_search", callId: "c2" } },
  { kind: "run_completed", payload: null },
  { kind: "run_started", payload: null },
  { kind: "tool_start", payload: { toolName: "search_public_cases", callId: "c3" } },
  { kind: "run_completed", payload: null },
];

expect("完整时间线按 callId 精确配对", matchToolCalls(items, calls), [-1, 0, 1, -1, -1, 2, -1]);

// 第 2 次运行的子集：必须仍指向 c3（旧实现在子集里重新计数会错挂 c1）
const run2 = items.filter((_, i) => i >= 4);
const run2Idx = matchToolCalls(items, calls).slice(4);
expect("按次运行子集取用完整配对结果", run2Idx, [-1, 2, -1]);
// 没有 callId 的历史事件在子集里会退化到第 1 次调用，所以配对必须基于完整时间线
const legacyRun2 = run2.map((it) => ({
  kind: it.kind,
  payload: it.payload ? { toolName: it.payload.toolName } : null,
}));
expect("无 callId 时子集重算会挂错（须用完整列表配对）", matchToolCalls(legacyRun2, calls), [-1, 0, -1]);

// 历史事件没有 callId：退回同名第 N 次
expect(
  "无 callId 退回同名序号",
  matchToolCalls(
    [
      { kind: "tool_start", payload: { toolName: "search_public_cases" } },
      { kind: "tool_start", payload: { toolName: "search_public_cases" } },
    ],
    calls,
  ),
  [0, 2],
);

// callId 失配（记录被清理）时退回同名序号，而不是直接丢弃
expect(
  "callId 失配退回同名序号",
  matchToolCalls([{ kind: "tool_start", payload: { toolName: "web_search", callId: "gone" } }], calls),
  [1],
);

// 找不到同名记录 → -1；非 tool_start → -1
expect(
  "无同名记录返回 -1",
  matchToolCalls([{ kind: "tool_start", payload: { toolName: "unknown_tool", callId: "x" } }], calls),
  [-1],
);
expect("空输入", matchToolCalls([], calls), []);
expect("空调用记录", matchToolCalls(items, []), [-1, -1, -1, -1, -1, -1, -1]);

console.log(`[verify] 时间线配对检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 时间线工具调用配对不符");
  process.exit(1);
}
console.log("[PASS] 时间线工具调用配对正确（callId 精确 + 同名序号兜底）");
