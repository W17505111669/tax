/**
 * 验证脚本：政策文号溯源（提取 / 归一化 / 三级口径 / 真实任务走查）。
 * 运行：pnpm verify:policy
 */
import {
  extractDocRefs,
  METADATA_ONLY_SEARCH_TOOLS,
  normalizeRef,
  traceDocRefs,
} from "../../web/src/policy-trace.ts";
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

// 1) 归一化与提取
expect("归一化括号与空格", normalizeRef("财税〔2015〕 119 号"), "财税[2015]119号");
expect("归一化中文方括号", normalizeRef("【2015】119号"), "[2015]119号");
expect("提取核心（六角括号）", extractDocRefs("按财税〔2015〕119号执行")[0]?.core, "[2015]119号");
expect("提取核心（半角括号 + 空格）", extractDocRefs("见财税[2015] 119 号")[0]?.core, "[2015]119号");
expect("提取公告类文号", extractDocRefs("国家税务总局公告2017年第40号")[0]?.core, "2017年第40号");
expect("同一文号多次出现只计一条并记次数", extractDocRefs("财税〔2015〕119号 与 财税〔2015〕119 号")[0]?.occurrences, 2);
expect("不同文号分别提取", extractDocRefs("财税〔2015〕119号、国税发〔2006〕187号").length, 2);
expect("按出现位置排序", extractDocRefs("国税发〔2006〕187号 在前，财税〔2015〕119号 在后").map((r) => r.core), [
  "[2006]187号",
  "[2015]119号",
]);
expect("无文号返回空", extractDocRefs("本段没有任何文号，只有 2025 年度和 100% 比例").length, 0);
expect("空文本返回空", extractDocRefs("").length, 0);
expect("上下文包含文号", extractDocRefs("依据财税〔2015〕119号第六条")[0]?.context.includes("119号"), true);

// 2) 三级口径
const results = [{ policies: [{ docNumber: "财税[2015]119号", ratio: 100 }] }];
expect("写法不同也能匹配（归一化后包含）", traceDocRefs("按财税〔2015〕119 号执行", results).traced, 1);
expect("无出处且未用联网检索 → 待确认", traceDocRefs("按国税发〔2006〕187号执行", results).untraced.length, 1);
expect(
  "无出处但用过 web_search → 无法核验",
  traceDocRefs("按国税发〔2006〕187号执行", results, ["web_search"]).unverifiable,
  1,
);
expect(
  "无法核验时不再列为待确认",
  traceDocRefs("按国税发〔2006〕187号执行", results, ["fetch_content"]).untraced.length,
  0,
);
expect("三类之和等于总数", (() => {
  const r = traceDocRefs("财税〔2015〕119号 与 国税发〔2006〕187号", results, ["web_search"]);
  return r.traced + r.unverifiable + r.untraced.length === r.total;
})(), true);
expect("元数据检索工具清单", [...METADATA_ONLY_SEARCH_TOOLS].sort(), ["fetch_content", "web_search"]);

// 3) 真实任务走查：三级口径必须自洽
let total = 0;
let traced = 0;
let unverifiable = 0;
let untraced = 0;
for (const t of listTasks()) {
  const detail = getTask(t.id);
  const text = detail?.result ?? "";
  if (!text.trim()) continue;
  const rows = db.prepare(`SELECT tool_name, result, ok FROM tool_calls WHERE task_id = ?`).all(t.id) as Array<{
    tool_name: string;
    result: string | null;
    ok: number | null;
  }>;
  const parsed = rows
    .filter((r) => r.ok === 1)
    .map((r) => {
      try {
        return r.result ? JSON.parse(r.result) : null;
      } catch {
        return null;
      }
    });
  const res = traceDocRefs(text, parsed, rows.map((r) => r.tool_name));
  checks += 1;
  if (res.traced + res.unverifiable + res.untraced.length !== res.total) {
    failures.push(`${t.id} 文号三级口径之和 ${res.traced + res.unverifiable + res.untraced.length} ≠ 总数 ${res.total}`);
  }
  total += res.total;
  traced += res.traced;
  unverifiable += res.unverifiable;
  untraced += res.untraced.length;
}
console.log(
  `[verify] 真实文号=${total} 有出处=${traced} 无法核验=${unverifiable} 待确认=${untraced}`,
);
console.log(`[verify] 文号溯源检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 政策文号溯源规则不符");
  process.exit(1);
}
console.log("[PASS] 政策文号溯源规则正确（提取 / 归一化 / 三级口径 / 真实任务自洽）");
