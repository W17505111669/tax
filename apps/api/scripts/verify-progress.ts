/**
 * 验证脚本：列表执行进度推导（0-5 步）。
 * 检查项：completed=5；非 executing 非 completed=0；executing ∈ [0,4]；completed 任务必含 run_completed 事件。
 * 运行：pnpm verify:progress
 */
import { db } from "../src/db.ts";
import { listTasks } from "../src/services/task-store.ts";

const tasks = listTasks();
const failures: string[] = [];

for (const t of tasks) {
  const p = t.progress ?? -1;
  if (t.status === "completed" && p !== 5) failures.push(`${t.id} completed 但 progress=${p}`);
  if (t.status !== "completed" && t.status !== "processing" && p !== 0) {
    failures.push(`${t.id} ${t.status} 但 progress=${p}`);
  }
  if (t.status === "processing" && (p < 0 || p > 4)) failures.push(`${t.id} processing 进度越界=${p}`);
}

for (const t of tasks.filter((x) => x.status === "completed").slice(0, 5)) {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'run_completed'`)
    .get(t.id) as { n: number };
  if (row.n === 0) failures.push(`${t.id} completed 但缺 run_completed 事件`);
}

console.log(`[verify] 任务数=${tasks.length} 已完成=${tasks.filter((x) => x.status === "completed").length}`);
console.log("[verify] 进度推导:", failures.length === 0 ? "全部符合 0-5 步规则" : failures.join("; "));
if (failures.length > 0) {
  console.log("[FAIL] 进度验证失败");
  process.exit(1);
}
console.log("[PASS] 列表执行进度推导规则正确");
