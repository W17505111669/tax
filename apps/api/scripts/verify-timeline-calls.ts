/**
 * 验证脚本：时间线 tool_start 事件与工具调用记录的配对。
 * 重点是「同名工具跨多次运行」时按次运行导出不会挂错入参/返回值。
 * 运行：pnpm verify:tlcalls
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchToolCalls } from "../../web/src/timeline-calls.ts";
import { applyEvent, createEventsAcc, FLUSH_MS } from "../../web/src/task-events.ts";
import type { AgentEvent } from "../../web/src/types.ts";
import { db } from "../src/db.ts";
import { listConclusions, listEvents, listTasks } from "../src/services/task-store.ts";

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

// ---- 事件聚合（task-events.ts）----
// 这段口径此前写在 useTaskEvents 的 SSE 回调里，每来一条事件就 setState 一次并复制整个数组。
// 搬出来之后才测得到：配对、流式合并、状态推进，以及「就地聚合」这个批量刷新的前提。
const AT = "2026-10-02T00:00:00.000Z";
const ev = (seq: number, kind: AgentEvent["kind"], extra: Partial<AgentEvent> = {}): AgentEvent => ({
  seq,
  taskId: "t1",
  kind,
  message: "",
  at: AT,
  ...extra,
});

const acc = createEventsAcc();
expect("初始状态是 created、三个容器都是空的", [acc.status, acc.timeline.length, acc.toolCalls.length, acc.stream], [
  "created",
  0,
  0,
  "",
]);
applyEvent(acc, ev(1, "run_started"));
applyEvent(acc, ev(2, "tool_start", { payload: { toolName: "web_search", callId: "c1", args: { q: "土增" } } }));
expect("run_started 推进状态", acc.status, "processing");
expect("tool_start 建一条调用记录，结果先空着", [acc.toolCalls.length, acc.toolCalls[0]!.result, acc.toolCalls[0]!.ok], [
  1,
  null,
  null,
]);
applyEvent(acc, ev(3, "tool_end", { payload: { toolName: "web_search", callId: "c1", ok: true, result: { a: 1 } } }));
expect("tool_end 按 callId 落位，结果与结束时间都写上", [acc.toolCalls[0]!.result, acc.toolCalls[0]!.ok, acc.toolCalls[0]!.endedAt], [
  { a: 1 },
  true,
  AT,
]);
expect("不新增第二条调用记录", acc.toolCalls.length, 1);
expect("时间线每条事件一行（run_started / tool_start / tool_end）", acc.timeline.map((t) => t.id), [
  "1-run_started",
  "2-tool_start",
  "3-tool_end",
]);
expect("tool_end 的时间线行不带 detail（详情在调用记录里）", acc.timeline[2]!.detail, undefined);

// 同名工具并发：按 callId 各归各的，这是「按工具名配对」那个老 bug 的回归
const par = createEventsAcc();
applyEvent(par, ev(1, "tool_start", { payload: { toolName: "web_search", callId: "a" } }));
applyEvent(par, ev(2, "tool_start", { payload: { toolName: "web_search", callId: "b" } }));
applyEvent(par, ev(3, "tool_end", { payload: { toolName: "web_search", callId: "b", ok: false, result: { e: 1 } } }));
applyEvent(par, ev(4, "tool_end", { payload: { toolName: "web_search", callId: "a", ok: true, result: { e: 2 } } }));
expect("同名并发按 callId 各归各的", par.toolCalls.map((c) => [c.id, c.ok, c.result]), [
  ["a", true, { e: 2 }],
  ["b", false, { e: 1 }],
]);

// 历史事件没有 callId：退回「同名且未结束」的最近一条
const legacy = createEventsAcc();
applyEvent(legacy, ev(1, "tool_start", { payload: { toolName: "fetch_content" } }));
applyEvent(legacy, ev(2, "tool_end", { payload: { toolName: "fetch_content", ok: true, result: { u: "x" } } }));
expect("无 callId 时 id 用 seq 兜底", legacy.toolCalls[0]!.id, "fetch_content#1");
expect("无 callId 退回同名未结束的那条", [legacy.toolCalls[0]!.result, legacy.toolCalls[0]!.ok], [{ u: "x" }, true]);
const orphan = createEventsAcc();
applyEvent(orphan, ev(1, "tool_end", { payload: { toolName: "web_search", callId: "nope", ok: true } }));
expect("配不上的 tool_end 不凭空造调用记录", orphan.toolCalls.length, 0);
expect("配不上的 tool_end 仍进时间线（事件本身是真的）", orphan.timeline.length, 1);

// 流式正文：delta 只在第一条时建时间线行，之后就地追加
const st = createEventsAcc();
applyEvent(st, ev(1, "agent_text_delta", { message: "一、" }));
applyEvent(st, ev(2, "agent_text_delta", { message: "结论" }));
applyEvent(st, ev(3, "agent_text"));
expect("delta 累计进 stream", st.stream, "一、结论");
expect("两条 delta 只产生一条时间线行", st.timeline.length, 1);
expect("时间线行的 detail 与 stream 同源", st.timeline[0]!.detail, "一、结论");
expect("agent_text 之后不再是流式态", [st.timeline[0]!.streaming, st.streamId], [false, null]);
applyEvent(st, ev(4, "agent_text_delta", { message: "补" }));
expect("agent_text 之后再来 delta 会另起一条", st.timeline.length, 2);
// 上面那条只数了行数，没管新那一行装的是什么、也没管 stream 有没有被收口清空。补两条：
// 另起的那条只能装新一轮的 delta（否则两次运行的结论会粘成一段，而 listConclusions 正是靠
// 「delta 累积、遇到 agent_text 收口」来分运行的）；stream 则**刻意不随收口清空**，它累计
// 两轮全文——这是既有行为，钉住它，将来谁想「顺手清一下」就得先想清楚前端还在用它做流式回显。
expect("另起的那条只装新一轮的 delta，不混进上一轮", st.timeline[1]!.detail, "补");
expect("stream 不随 agent_text 收口清空，累计两轮全文", st.stream, "一、结论补");
applyEvent(st, ev(5, "run_completed"));
expect("run_completed 推进状态", st.status, "completed");
applyEvent(st, ev(6, "run_failed"));
expect("run_failed 推进状态", st.status, "failed");

// 就地聚合是批量刷新的前提：一旦每条事件都换新数组，hook 那边的批处理就白做了
const inplace = createEventsAcc();
const timelineRef = inplace.timeline;
const callsRef = inplace.toolCalls;
for (let i = 0; i < 5; i++) applyEvent(inplace, ev(i, "tool_start", { payload: { toolName: "t", callId: `c${i}` } }));
expect("聚合就地改数组，不换数组身份", [inplace.timeline === timelineRef, inplace.toolCalls === callsRef], [true, true]);

// 量一个此前没量过的数：超大任务的事件回放（实测最大 13829 条）在聚合层要多久
const big = createEventsAcc();
const BIG_N = 14000;
let deltas = 0;
const t0 = Date.now();
for (let i = 0; i < BIG_N; i++) {
  if (i % 3 === 0) deltas += 1;
  applyEvent(
    big,
    i % 3 === 0
      ? ev(i, "agent_text_delta", { message: "字" })
      : ev(i, i % 3 === 1 ? "tool_start" : "tool_end", { payload: { toolName: "t", callId: `c${i}` } }),
  );
}
const bigMs = Date.now() - t0;
// 期望值由计数器给出：非 delta 事件各占一行，上万条 delta 合并成流式那一行
expect("每条非 delta 事件各占一行、上万条 delta 合并成一行", big.timeline.length, BIG_N - deltas + 1);
expect("确实聚合了上万条事件（不是空跑）", big.timeline.length > 9000, true);
expect("聚合层不是瓶颈（1 万条以上也要在 5 秒内跑完）", bigMs < 5000, true);
console.log(`[verify] 事件聚合：${BIG_N} 条事件耗时 ${bigMs} ms（界面此前每条事件一次 setState + 一次全量数组复制）`);

// hook 那侧必须真的批处理，否则聚合层再快也白搭
const here = path.dirname(fileURLToPath(import.meta.url));
const hookSrc = fs.readFileSync(path.resolve(here, "..", "..", "web", "src", "hooks", "useTaskEvents.ts"), "utf8");
expect("hook 里不再每条事件复制一次时间线数组", hookSrc.includes("setTimeline((prev)"), false);
expect("hook 里不再每条事件复制一次调用数组", hookSrc.includes("setToolCalls((prev)"), false);
expect("hook 按固定间隔批量刷新", hookSrc.includes("setTimeout(flush, FLUSH_MS)"), true);
expect("刷新间隔取自 task-events.ts（两边不各写一个数）", [hookSrc.includes("FLUSH_MS"), FLUSH_MS > 0], [true, true]);
expect("聚合口径不在 hook 里重复实现", hookSrc.includes("STATUS_LABEL"), false);
// 返回的字段还必须与唯一消费者的解构一一对应：多出来的就是只写不读的死字段。
// 实测踩过：useTaskEvents 曾把 acc.stream 镜像进 useState 并对外返回，而 TaskWorkbench 从来没
// 解构过它——每批 flush 白写一次 state，那个字符串还按全任务所有轮次累积（实测单任务最多
// 24717 行 delta、平均每行约 6.7 字）。聚合器里的 stream 留着（上面「delta 累计进 stream」
// 「不随收口清空」那几条钉它），只是不再对外暴露。判据写成「两个集合相等」而不是逐个点名，
// 将来再往返回值里塞一个没人读的字段同样会被抓住。
const benchTlSrc = fs.readFileSync(
  path.resolve(here, "..", "..", "web", "src", "components", "TaskWorkbench.tsx"),
  "utf8",
);
const fieldsOfHook = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean).sort();
const hookRet = fieldsOfHook(/return \{ ([^}]+) \};/.exec(hookSrc)?.[1] ?? "");
const benchUse = fieldsOfHook(/const \{ ([^}]+) \} = useTaskEvents\(/.exec(benchTlSrc)?.[1] ?? "");
expect("TaskWorkbench 源码真读到了（这条走查不能空跑）", benchTlSrc.length > 10000, true);
expect("hook 的返回字段确实解析出来了（正则没失配）", hookRet.length >= 5, true);
expect("hook 返回的字段与唯一消费者的解构一一对应（多出来的就是没人读的死字段）", hookRet, benchUse);
expect("hook 不再把只写不读的 stream 镜像进 state", hookSrc.includes("setStream"), false);

// ---- 结论正文的两份存放必须一致 ----
// `tasks.result` 是运行结束时写下的那一份；`events` 里的 agent_text_delta 分片按 listConclusions
// 的规则重组出「每次运行一段结论」。界面上结果页正文走前者、「上次运行结论 / 结论较上次运行变化」
// 走后者，两边不一致就是同一份材料各说一套。实测 37 个有结论的任务全部一致、0 个不一致，
// 但此前一条断言都没有——一致靠的是运气，不是被钉住的口径。
let conclSame = 0;
let conclDiff = 0;
let conclNone = 0;
for (const t of listTasks()) {
  const stored = String(
    (db.prepare(`SELECT COALESCE(result,'') AS r FROM tasks WHERE id = ?`).get(t.id) as { r: string }).r,
  );
  if (stored === "") {
    conclNone += 1;
    continue;
  }
  const runs = listConclusions(t.id);
  const last = runs[runs.length - 1] ?? "";
  checks += 1;
  if (last === stored) {
    conclSame += 1;
  } else {
    conclDiff += 1;
    failures.push(
      `${t.id.slice(0, 8)} 结论两份存放不一致：tasks.result ${stored.length} 字 vs 事件重组最后一段 ${last.length} 字（重组 ${runs.length} 段）`,
    );
  }
}
expect("确实对到了有结论的真实任务（不是空跑）", conclSame >= 1, true);
const noResultTasks = (
  db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE COALESCE(result,'') = ''`).get() as { n: number }
).n;
expect("没有结论的任务不参与比对，但数目必须与库里一致", conclNone, noResultTasks);
console.log(`[verify] 结论两份存放：一致 ${conclSame} · 不一致 ${conclDiff} · 无结论 ${conclNone}`);

// ---- 运行次数的两份实现必须逐个任务相等 ----
// 服务端 runCountOf 数的是 events 表里 kind='run_started' 的行数，listTasks 把它下发给侧栏列表、
// CSV 导出与看板「最近活动」；任务页与交付 MD 头部、manifest 用的是组件里
// timeline.filter(kind === "run_started").length（事件聚合后的时间线，为的是运行中能实时 +1）。
// 两份实现各有理由（一个要持久、一个要实时），所以不合并，但必须钉住相等：只要 applyEvent 对
// run_started 的处理变了（例如与别的事件合并成一行），任务页与交付 MD 就会与侧栏、CSV 各说
// 一个数，而两边看起来都挺对的——这类分歧不会让任何一侧报错，只会让对外数字悄悄分家。
let rcSame = 0;
let rcDiff = 0;
let rcTasks = 0;
let rcRuns = 0;
const rcBad: string[] = [];
for (const t of listTasks()) {
  const acc = createEventsAcc();
  for (const ev of listEvents(t.id)) applyEvent(acc, ev);
  const fromTimeline = acc.timeline.filter((x) => x.kind === "run_started").length;
  const fromDb = t.runCount ?? 0;
  rcTasks += 1;
  rcRuns += fromDb;
  if (fromTimeline === fromDb) rcSame += 1;
  else {
    rcDiff += 1;
    rcBad.push(`${t.id.slice(0, 8)} 时间线 ${fromTimeline} 次 vs 库 ${fromDb} 次`);
  }
}
expect("运行次数确实走到了任务（不是空跑）", rcTasks > 0, true);
// 全库累计为 0 时「两份都是 0」也相等，那条相等断言就成了空真——所以累计次数必须大于 0
expect("确实数到了运行（累计运行次数 > 0，否则「相等」是空真）", rcRuns > 0, true);
expect("运行次数两份实现逐个任务相等", rcBad, []);
console.log(
  `[verify] 运行次数两份实现：任务 ${rcTasks} 个 · 一致 ${rcSame} · 不一致 ${rcDiff} · 全库累计运行 ${rcRuns} 次`,
);
// 兜底方向也要钉住：runCount 在类型上是 optional，缺失时按 0 处理，不按 1。
// 侧栏那张 CSV 里工具次数与进度缺失都写 0，只有运行次数写 `?? 1`——那等于替一个「建了没跑」
// 的任务凭空造出一次运行，而 CSV 是对外交付物。徽标那两处 `(runCount ?? 1) > 1` 行为上没错
//（1 与 0 都不大于 1，缺失时都不显示徽标），但它是**用兜底值来表达「不显示」**：
// 将来谁把条件改成 >= 1，缺失字段的任务就会显示「↻1」，同样是凭空造一次运行。
const sidebarSrc = fs.readFileSync(
  path.resolve(here, "..", "..", "web", "src", "components", "Sidebar.tsx"),
  "utf8",
);
const overviewSrc = fs.readFileSync(
  path.resolve(here, "..", "..", "web", "src", "components", "AgentOverview.tsx"),
  "utf8",
);
expect("两份组件源码都真读到了（静态走查不能空跑）", [sidebarSrc.length > 5000, overviewSrc.length > 5000], [
  true,
  true,
]);
expect(
  "运行次数缺失时按 0 兜底、不凭空造一次运行",
  [sidebarSrc.includes("runCount ?? 1"), overviewSrc.includes("runCount ?? 1")],
  [false, false],
);
expect(
  "运行次数确实带着兜底（字段是 optional，漏了兜底会渲染出 undefined）",
  [sidebarSrc.includes("runCount ?? 0"), overviewSrc.includes("runCount ?? 0")],
  [true, true],
);

console.log(`[verify] 时间线配对检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 时间线工具调用配对不符");
  process.exit(1);
}
console.log("[PASS] 时间线工具调用配对正确（callId 精确 + 同名序号兜底）");
