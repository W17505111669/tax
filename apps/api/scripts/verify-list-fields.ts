/**
 * 验证脚本：列表接口附带字段（单任务比对一致率/覆盖率、结论正文引用数）与独立重算逐任务对账，
 * 并断言 citeCache 二次取数一致——防止列表口径与 stats.ts / 正文解析漂移成两套数字。
 * 运行：pnpm verify:listfields
 */
import { compareRates } from "@tax/document-tools";
import { db } from "../src/db.ts";
import { listTasks } from "../src/services/task-store.ts";
import { summarizeTaskCompares, type CompareCall } from "../src/services/compare-stats.ts";
import { extractTextCitations, UNCAPPED } from "../../web/src/search-evidence.ts";

const fails: string[] = [];
function expect(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fails.push(`${name}: 实际 ${JSON.stringify(actual)} 期望 ${JSON.stringify(expected)}`);
  }
}

const tasks = listTasks();
if (tasks.length === 0) {
  console.log("[verify] 列表附带字段检查项=1 失败=1");
  console.log("\n[FAIL] 空跑防护：listTasks 返回 0 个任务，无法证明附带字段真走真实数据。");
  process.exit(1);
}
const callStmt = db.prepare(
  `SELECT tool_name, ok, args, result, started_at FROM tool_calls
   WHERE task_id = ? AND tool_name = 'compare_workpapers' ORDER BY started_at DESC`,
);
const resultStmt = db.prepare(`SELECT result FROM tasks WHERE id = ?`);

for (const t of tasks) {
  const calls = callStmt.all(t.id) as CompareCall[];
  const summary = summarizeTaskCompares(calls);
  const rates = summary.peer
    ? compareRates(summary.peer.matched, summary.peer.mismatched, summary.peer.onlyA)
    : null;
  expect(
    `比对比率 ${t.caseId}`,
    [t.compareMatchRate ?? null, t.compareCoverage ?? null],
    rates ? [rates.matchRatePercent, rates.coveragePercent] : [null, null],
  );
  const row = resultStmt.get(t.id) as { result: string | null };
  expect(
    `引用数 ${t.caseId}`,
    t.citationCount ?? 0,
    row.result ? extractTextCitations(row.result, UNCAPPED).length : 0,
  );
}

// 缓存路径：第二次列表取数必须与第一次逐任务一致（updatedAt 签名失效逻辑不能被缓存绕过）
const again = listTasks();
expect(
  "缓存复取一致",
  again.map((t) => [t.id, t.citationCount, t.compareMatchRate, t.compareCoverage]),
  tasks.map((t) => [t.id, t.citationCount, t.compareMatchRate, t.compareCoverage]),
);

const withRates = tasks.filter((t) => t.compareMatchRate !== undefined && t.compareMatchRate !== null).length;
const citeSum = tasks.reduce((s, t) => s + (t.citationCount ?? 0), 0);
// 真实数据锚：当前库必须有带比对比率的任务与正文引用，否则说明取数链路静默归零
expect("真实数据锚：存在带比对比率的任务", withRates > 0, true);
expect("真实数据锚：正文引用合计大于 0", citeSum > 0, true);
console.log(`[verify] 列表字段对账：任务 ${tasks.length} 个 · 带比对比率 ${withRates} 个 · 正文引用合计 ${citeSum} 条`);
console.log(`[verify] 列表附带字段检查项=${tasks.length * 2 + 1} 失败=${fails.length}`);
if (fails.length > 0) {
  for (const f of fails) console.log(`  - ${f}`);
  console.log("\n[FAIL] 列表附带字段与独立重算不一致。");
  process.exitCode = 1;
} else {
  console.log("[PASS] 列表附带字段（比对比率/引用数）与独立重算一致，缓存复取一致");
}
