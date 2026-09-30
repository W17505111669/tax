/**
 * 验证脚本：失败工具调用的归因分类（tool-failures.ts）。
 *
 * 这个模块是随「失败的工具调用」面板一起加的，当时**漏了配验证脚本**——分类规则一条断言都没有，
 * 改错了也没人知道。断言用的错误正文全部取自库里真实出现过的失败，不是编的样例：分类规则本来
 * 就是照着这 7 条写的，用别的字符串测等于没测。
 *
 * 运行：pnpm verify:tfails
 */
import {
  CAUSE_HINTS,
  CAUSE_LABELS,
  classifyFailure,
  failureSummary,
  groupFailures,
  type FailureCause,
  type FailureItem,
} from "../../web/src/tool-failures.ts";
import { computePlatformStats } from "../src/services/stats.ts";

let checks = 0;
const failures: string[] = [];

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

// 1) 分类：每一条都取自库里真实出现过的失败正文
const REAL_ERRORS: Array<[string, FailureCause]> = [
  ["No query specified", "bad_args"],
  ["No URL specified", "bad_args"],
  ["Missing required parameter: url", "bad_args"],
  ["Only HTTP and HTTPS URLs can be fetched remotely", "unsupported"],
  [
    "HTTP 404: Not Found The origin server says this page does not exist (HTTP 404), so extraction providers cannot retrieve it.",
    "not_found",
  ],
  [
    "HTTP 412: Precondition Failed Fallback options: • Set firecrawlBaseUrl in C:\\Users\\x\\.pi\\agent\\web-search.json to a self-hosted Firecrawl instance",
    "upstream",
  ],
  ["HTTP 429: Too Many Requests", "upstream"],
  ["request timeout after 30000ms", "upstream"],
  // 实测 fetch_content 抓某些页面时抛的：既不是入参问题也不是对方资源问题
  ["Cannot read properties of null (reading 'tagName')\n\nFallback options:", "tool_bug"],
  ["TypeError: x.forEach is not a function", "tool_bug"],
  ["", "unknown"],
  ["一些没有匹配到任何已知模式的错误描述", "unknown"],
];
for (const [text, want] of REAL_ERRORS) {
  expect(`分类「${text.slice(0, 42).replace(/\s+/g, " ")}…」`, classifyFailure(text), want);
}
// 异常文本里可能顺带出现 "not found"，不能被抢归到外部资源不存在
expect("内部异常优先于 not_found", classifyFailure("TypeError: host not found in registry"), "tool_bug");

// 2) 类别表自洽：每个类别都有标签与处置建议，且展示顺序不重不漏
const ALL_CAUSES: FailureCause[] = ["bad_args", "unsupported", "tool_bug", "not_found", "upstream", "unknown"];
for (const c of ALL_CAUSES) {
  ok(`类别 ${c} 有非空标签`, (CAUSE_LABELS[c] ?? "").trim().length > 0);
  ok(`类别 ${c} 有处置建议且以「处置」给出动作`, (CAUSE_HINTS[c] ?? "").includes("处置"));
}
expect("标签互不重复", new Set(Object.values(CAUSE_LABELS)).size, ALL_CAUSES.length);
const grouped = groupFailures(
  REAL_ERRORS.map(([error], i) => ({
    taskId: `t${i}`,
    taskTitle: `任务${i}`,
    agentId: "rd-audit",
    toolName: "fetch_content",
    error,
    args: "url=https://x.gov.cn/a",
    startedAt: `2026-09-30T0${i % 10}:00:00.000Z`,
  })),
);
const order = grouped.map((g) => g.cause);
expect("分组按既定顺序出现（能治的在前，未归类垫底）", order, [
  "bad_args",
  "unsupported",
  "tool_bug",
  "upstream",
  "not_found",
  "unknown",
]);
expect("分组不重不漏地覆盖全部输入", grouped.reduce((n, g) => n + g.items.length, 0), REAL_ERRORS.length);
expect("每组带标签与处置建议", grouped.every((g) => g.label.length > 0 && g.hint.length > 0), true);

// 3) 组内按时间倒序，且同一批输入两次调用结果完全一致（导出与截图才对得上）
const two: FailureItem[] = [
  { taskId: "a", taskTitle: "A", agentId: "rd-audit", toolName: "web_search", error: "No URL specified", args: "", startedAt: "2026-09-28T01:00:00.000Z" },
  { taskId: "b", taskTitle: "B", agentId: "rd-audit", toolName: "web_search", error: "No query specified", args: "", startedAt: "2026-09-30T05:00:00.000Z" },
];
expect(
  "同类内按时间倒序（最近的先看到）",
  groupFailures(two)[0]!.items.map((i) => i.taskId),
  ["b", "a"],
);
expect("同一批输入两次分组结果一致", JSON.stringify(groupFailures(two)), JSON.stringify(groupFailures(two)));

// 4) 汇总：fixableByUs 只算「改提示词或用法约束就能减少」的两类，工具内部异常与外部因素不算
const sum = failureSummary(
  REAL_ERRORS.map(([error], i) => ({
    taskId: `t${i}`,
    taskTitle: `任务${i}`,
    agentId: "rd-audit",
    toolName: "x",
    error,
    args: "",
    startedAt: "2026-09-30T00:00:00.000Z",
  })),
);
expect("汇总总条数", sum.total, REAL_ERRORS.length);
// REAL_ERRORS 覆盖全部 6 个类别（含 unknown），所以是 6 组
expect("汇总类别数", sum.causes, ALL_CAUSES.length);
expect("可由我们治好的条数只含 bad_args 与 unsupported", sum.fixableByUs, 4);
expect("空清单安全兜底", failureSummary([]), { total: 0, causes: 0, fixableByUs: 0 });
expect("空清单分组为空数组", groupFailures([]), []);

// 5) 真实数据走查：库里每条失败都要能归到某一类，且各类条数之和等于失败总数
const s = computePlatformStats();
const realGroups = groupFailures(s.toolFailures);
expect("平台失败明细条数与失败总数一致", s.toolFailures.length, s.toolFailed);
expect("各类条数之和等于明细条数", realGroups.reduce((n, g) => n + g.items.length, 0), s.toolFailures.length);
ok(
  "真实失败里没有「未归类」（有就说明出现了没见过的错误模式，该补一条规则）",
  realGroups.every((g) => g.cause !== "unknown"),
  realGroups.filter((g) => g.cause === "unknown").map((g) => g.items[0]?.error.slice(0, 60)).join("；"),
);
ok("确实走查到了真实失败数据", s.toolFailures.length > 0, `${s.toolFailures.length} 条`);
expect(
  "每条明细都带了排查要用的字段（工具名、错误正文、入参摘要、时间、可跳转的任务）",
  s.toolFailures.every((f) => f.toolName !== "" && f.error !== "" && f.args !== "" && f.startedAt !== "" && f.taskId !== ""),
  true,
);

console.log(
  `[verify] 真实失败 ${s.toolFailed} 条归类：${realGroups.map((g) => `${g.label} ${g.items.length}`).join(" · ") || "(无)"}`,
);
console.log(`[verify] 失败归因检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 失败归因分类不符");
  process.exit(1);
}
console.log("[PASS] 失败归因分类正确（真实错误正文 / 类别表自洽 / 排序确定 / 汇总口径 / 真实数据走查）");
