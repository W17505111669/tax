/**
 * 验证脚本：结论金额溯源（提取规则 / 工具数值收集 / 三级口径 / 真实任务走查）。
 * 运行：pnpm verify:amounts
 */
import { collectToolCents, extractAmounts, traceAmounts } from "../../web/src/amount-trace.ts";
import { db } from "../src/db.ts";
import { getTask, listTasks } from "../src/services/task-store.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

// 1) 提取规则
expect("千分位 + 元", extractAmounts("合同金额 12,000,000.00 元").map((a) => a.cents), [1200000000]);
expect("万元换算", extractAmounts("财政补助 50 万元").map((a) => a.cents), [50000000]);
expect("负号差异", extractAmounts("差异 -460,000.00 元").map((a) => a.cents), [-46000000]);
expect("U+2212 负号", extractAmounts("差额 −6,666.67").map((a) => a.cents), [-666667]);
expect("百分号不计入", extractAmounts("加计扣除比例 100%").length, 0);
expect("年份不计入", extractAmounts("2025 年度研发项目").length, 0);
expect("量词不计入", extractAmounts("共 3 份合同、6 大类费用").length, 0);
expect("URL 中的数字不计入", extractAmounts("见 https://x.gov.cn/t.php?tid=27828 与 /c100012/c5194166/").length, 0);
expect("无单位但带千分位/位数足够时计入", extractAmounts("金额 1,200,000 与 860000").map((a) => a.cents), [
  120000000, 86000000,
]);
expect("上下文片段非空", extractAmounts("辅助账 860,000.00 元")[0]?.context.includes("860,000.00"), true);

// 2) 工具数值收集（元 / 分双量纲）
const pool = collectToolCents([{ amountYuan: "5,000,000.00", cents: 420000, nested: [{ v: 860000 }] }, "不是数字"]);
expect("字符串金额按元登记", pool.has(500000000), true);
expect("数值同时登记元与分", [pool.has(42000000), pool.has(420000)], [true, true]);
expect("嵌套数组可收集", pool.has(86000000), true);
expect("非数值字符串忽略", pool.size > 0 && !pool.has(Number.NaN), true);

// 3) 三级口径
const results = [{ diff: 460000, total: "12,000,000.00" }];
const text = "合同金额 12,000,000.00 元，差异 -460,000.00 元；客户提供 5,000,000.00 元；推算 84,444.44 元。";
const trace = traceAmounts(text, results, "发票 FP-001 金额 5,000,000.00 元");
expect("工具结果可溯源", trace.traced, 2);
expect("来自客户指令", trace.fromInput, 1);
expect("两边都没有 → 待确认（raw 保留原文单位）", trace.untraced.map((u) => u.raw), ["84,444.44元"]);
expect("总数一致", trace.total, trace.traced + trace.fromInput + trace.untraced.length);
expect("符号不敏感匹配（结论负数 / 工具正数）", traceAmounts("差异 -460,000.00 元", results).traced, 1);
expect("空结论", traceAmounts("", results).total, 0);

// 4) 真实任务走查：可溯源比例不得低于 90%（当前实现约 96%）
let total = 0;
let explained = 0;
let tasks = 0;
const worst: string[] = [];
for (const t of listTasks()) {
  const detail = getTask(t.id);
  const text2 = detail?.result ?? "";
  if (!text2.trim()) continue;
  const rows = db.prepare(`SELECT result FROM tool_calls WHERE task_id = ? AND ok = 1`).all(t.id) as Array<{
    result: string | null;
  }>;
  const parsed = rows.map((r) => {
    try {
      return r.result ? JSON.parse(r.result) : null;
    } catch {
      return null;
    }
  });
  const res = traceAmounts(text2, parsed, detail?.instruction ?? "");
  tasks += 1;
  total += res.total;
  explained += res.traced + res.fromInput;
  if (res.untraced.length > 0) worst.push(`${t.id.slice(0, 8)}:${res.untraced.length}/${res.total}`);
}
checks += 1;
const ratio = total === 0 ? 1 : explained / total;
if (ratio < 0.9) failures.push(`真实任务金额溯源比例 ${(ratio * 100).toFixed(1)}% 低于 90%`);
console.log(
  `[verify] 真实任务=${tasks} 金额=${total} 可溯源=${explained} 待确认=${total - explained} 比例=${(
    ratio * 100
  ).toFixed(1)}%`,
);
if (worst.length > 0) console.log(`[verify] 含待确认金额的任务：${worst.join(" ")}`);

console.log(`[verify] 金额溯源检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 金额溯源规则不符");
  process.exit(1);
}
console.log("[PASS] 金额溯源规则正确（提取 / 双量纲收集 / 三级口径 / 真实任务比例）");
