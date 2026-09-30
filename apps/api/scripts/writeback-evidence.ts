/**
 * 把「已找到公开出处」的联网复查结果写回结论。
 *
 * 平台不自动改写结论：结果页的「生成修订指令」只是把复查结果整理成一条续跑指令，
 * 改不改、怎么改由税务师决定。这个脚本等价于把那些任务逐个点一遍——生成指令、续跑、
 * 跑完给出前后对比，便于赛前一次性补齐证据。默认只列出计划不落库，加 --run 才真跑。
 *
 * 运行：pnpm writeback:evidence                          列出可写回的任务与指令摘要
 *      pnpm writeback:evidence --print                   打印完整修订指令（人工核对用）
 *      pnpm writeback:evidence --task aabd138 --run      只续跑指定任务（id 前缀）
 *      pnpm writeback:evidence --run                     逐个续跑全部可写回任务（耗时，慎用）
 *      pnpm writeback:evidence --restore aabd138         把该任务的结论回滚到上一轮（续跑改坏时用）
 */
import { runTask } from "../src/services/agent-runner.ts";
import { listRefChecks } from "../src/services/ref-checks.ts";
import { listLinkChecks } from "../src/services/link-checks.ts";
import { appendEvent, getTask, listConclusions, listTasks, setTaskStatus } from "../src/services/task-store.ts";
import { computePlatformStats } from "../src/services/stats.ts";
import {
  buildRevisionInstruction,
  deadLinkTargets,
  pendingRevisionItems,
  toRevisionItems,
} from "../../web/src/ref-check.ts";
import { db } from "../src/db.ts";
import { extractCitations, extractTextCitations, mergeCitations, UNCAPPED } from "../../web/src/search-evidence.ts";

const args = process.argv.slice(2);
const doRun = args.includes("--run");
const doPrint = args.includes("--print");
const at = args.indexOf("--task");
const taskFilter = at >= 0 ? (args[at + 1] ?? "") : "";
const rt = args.indexOf("--restore");
const restoreFilter = rt >= 0 ? (args[rt + 1] ?? "") : "";

type Snapshot = {
  docRefs: number;
  docRefTraced: number;
  docRefPending: number;
  docRefMatched: number;
  citations: number;
  official: number;
  weak: number;
  amountPending: number;
  amountTotal: number;
};

const snapshot = (): Snapshot => {
  const e = computePlatformStats().evidence;
  return {
    docRefs: e.docRefs,
    docRefTraced: e.docRefTraced,
    docRefPending: e.docRefPending,
    docRefMatched: e.docRefMatched,
    citations: e.citations,
    official: e.officialCitations,
    weak: e.weakCitations,
    amountPending: e.ledger.reduce((a, r) => a + r.amountPending, 0),
    amountTotal: e.ledger.reduce((a, r) => a + r.amountTotal, 0),
  };
};

const line = (s: Snapshot): string =>
  `文号 ${s.docRefTraced}/${s.docRefs} 有出处 · 待复查 ${s.docRefPending} · 复查到出处 ${s.docRefMatched} · 引用 ${s.citations}（官方 ${s.official} · 弱 ${s.weak}）· 金额待确认 ${s.amountPending}/${s.amountTotal}`;

const delta = (a: number, b: number): string => (b > a ? `+${b - a}` : b < a ? `${b - a}` : "0");

// 回滚出口：续跑把结论改坏时（实测模型交回过一份改动报告，文号 5 → 2、金额溯源项少 22 个），
// 不必手改数据库。事件流只增不改，每一轮结论都能重建，因此可以反复回滚。
if (restoreFilter !== "") {
  const target = listTasks().find((x) => x.id.startsWith(restoreFilter));
  if (target === undefined) {
    console.log(`没有匹配 ${restoreFilter} 的任务`);
    process.exit(1);
  }
  const runs = listConclusions(target.id);
  if (runs.length < 2) {
    console.log(`${target.id.slice(0, 8)}「${target.title}」只有一轮结论，无从回滚`);
    process.exit(1);
  }
  const prev = runs[runs.length - 2]!;
  const dropped = runs[runs.length - 1]!;
  const round = runs.length;
  // 事件流是唯一事实来源，verify:revimpact 盯着一条不变量：重组出的最后一轮结论必须等于 tasks.result。
  // 所以回滚不能只改 result——那等于让数据库与事件流各说一套，门禁当场就抓出来了（第一版正是这么写的）。
  // 这里把回滚如实记成一轮，事件形状与正常一轮完全一致，时间线、运行次数与结论重组才都对得上。
  appendEvent(target.id, "run_started", `人工回滚：把结论恢复到第 ${round - 1} 轮（换下第 ${round} 轮）`, {
    rollback: true,
    restoredChars: prev.length,
    droppedChars: dropped.length,
  });
  appendEvent(target.id, "agent_text_delta", prev);
  appendEvent(target.id, "agent_text", prev);
  setTaskStatus(target.id, target.status, { result: prev });
  appendEvent(target.id, "run_completed", "人工回滚完成", { result: prev, rollback: true });
  console.log(
    `已把 ${target.id.slice(0, 8)}「${target.title}」的结论回滚到第 ${round - 1} 轮（${prev.length} 字）；被换下的第 ${round} 轮（${dropped.length} 字）仍留在事件流里，回滚本身也记为一轮，状态保持 ${target.status} 不变`,
  );
  process.exit(0);
}

// 没有结论的任务不进清单，但要如实报出来而不是静默丢掉。
// 写回是「把已核实的出处补进结论正文」，结论为空时无处可补；此时续跑只会让 Agent 凭空
// 生成一份新结论，那不叫写回，叫重写。与 pendingCitationTargets 同一道守卫——实测失败任务
// 060b4eea 结论为空，此前却照样列出 4 条素材、生成 923 字指令，照着 --run 就是让模型编结论。
const noConclusion: string[] = [];
const built = listTasks()
  .filter((t) => taskFilter === "" || t.id.startsWith(taskFilter))
  .map((t) => {
    const result = getTask(t.id)?.result ?? "";
    if (result.trim() === "") {
      noConclusion.push(`${t.id.slice(0, 8)} ${t.title}（${t.status}）`);
      return null;
    }
    // 已经写回的不再进指令，两类判据：
    // 1. 找到出处的素材——结论正文里出现过这条证据地址，就说明上一轮续跑已经补上了；
    // 2. 查不到原文的素材——结论里已写明「仅作背景参考，不作为政策依据」，交代过了就不必再交代一遍
    //   （此前这类素材没有判据，每轮续跑都重复列出，实测 4bb22d34 白跑 300 秒重写同一节表格）。
    const items = pendingRevisionItems(
      toRevisionItems(listRefChecks(t.id)).filter(
        (i) => i.verdict !== "matched" || !i.evidence || !result.includes(i.evidence.url),
      ),
      result,
    );
    // 失效链接也进指令：链接腐烂此前只能被交付自检发现、没法走修复通道，唯一出路是人工改正文。
    // 引用清单按全量取（与平台统计同口径），deadLinkTargets 内部会再按当前清单过滤掉过期核验行。
    const calls = (db.prepare(`SELECT tool_name, result FROM tool_calls WHERE task_id = ?`).all(t.id) ?? []) as Array<{
      tool_name: string;
      result: string | null;
    }>;
    const parsed = calls.map((c) => {
      let parsedResult: unknown = null;
      try {
        parsedResult = c.result ? JSON.parse(c.result) : null;
      } catch {
        parsedResult = null;
      }
      return { toolName: c.tool_name, result: parsedResult };
    });
    const cites = mergeCitations(
      extractCitations(parsed, UNCAPPED),
      extractTextCitations(result, UNCAPPED),
      UNCAPPED,
    );
    const dead = deadLinkTargets(listLinkChecks(t.id), cites);
    return { task: t, items, dead, instruction: buildRevisionInstruction(items, dead) };
  });
const plans = built.filter((p): p is NonNullable<typeof p> => p !== null && p.instruction !== "");

if (noConclusion.length > 0) {
  console.log(
    `已跳过 ${noConclusion.length} 个没有结论的任务（写回要补进结论正文，结论为空时无处可补；续跑只会让模型凭空生成一份结论）：`,
  );
  for (const s of noConclusion) console.log(`  - ${s}`);
  console.log("");
}

if (plans.length === 0) {
  console.log(taskFilter ? `没有匹配 ${taskFilter} 且可写回的任务` : "没有可写回的复查结果（各任务都还没有出结果的联网复查）");
  process.exit(0);
}

console.log(`可写回任务 ${plans.length} 个：`);
for (const p of plans) {
  const matched = p.items.filter((i) => i.verdict === "matched").length;
  const docs = p.items.filter((i) => i.kind === "docref" && i.verdict === "matched").length;
  const cites = p.items.filter((i) => i.kind === "citation" && i.verdict === "matched").length;
  console.log(
    `  - ${p.task.id.slice(0, 8)} ${p.task.title}（${p.task.status}）：素材 ${p.items.length} 条 · 文号出处 ${docs} · 官方替代 ${cites} · 待人工标注 ${
      p.items.length - matched
    } · 失效链接 ${p.dead.length} 条 · 指令 ${p.instruction.length} 字`,
  );
}
console.log("（结论正文里已出现过证据地址的素材视为已写回，不再列入，脚本可重复运行）");

if (doPrint) {
  for (const p of plans) console.log(`\n===== ${p.task.title}（${p.task.id}）=====\n${p.instruction}`);
}

if (!doRun) {
  console.log("\n（默认只列计划不执行：人工核对指令后加 --run，建议配 --task 一个一个跑）");
  process.exit(0);
}

const before = snapshot();
// 逐任务留一份写回前的台账行：平台合计只能说明「总体变少了」，指不出是哪个任务改坏的
const beforeRows = new Map(computePlatformStats().evidence.ledger.map((r) => [r.taskId, r]));
console.log(`\n写回前：${line(before)}`);
for (const p of plans) {
  const started = Date.now();
  console.log(`\n→ 续跑「${p.task.title}」（${p.task.id.slice(0, 8)}）…`);
  try {
    // 修订模式：机制上摘掉会重写产物与比对记录的工具，不只靠指令里那句嘱咐
    await runTask(p.task.id, p.instruction, { resume: true, revisionOnly: true });
  } catch (err) {
    console.log(`  失败：${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  const after = getTask(p.task.id);
  const row = computePlatformStats().evidence.ledger.find((r) => r.taskId === p.task.id);
  console.log(
    `  完成，用时 ${Math.round((Date.now() - started) / 1000)} 秒 · 状态 ${after?.status ?? "?"} · 文号 ${row?.docRefTraced ?? 0}/${
      row?.docRefTotal ?? 0
    } 有出处 · 引用 ${row?.citations ?? 0}（官方 ${row?.official ?? 0}）· 修订影响「${row?.revision ?? "无可比轮次"}」`,
  );
  const prevRow = beforeRows.get(p.task.id);
  const lostDocs = (prevRow?.docRefTotal ?? 0) - (row?.docRefTotal ?? 0);
  const lostAmounts = (prevRow?.amountTotal ?? 0) - (row?.amountTotal ?? 0);
  // 还要盯「新增了没有出处的文号」：模型补出处时常常顺手把来源文件自己引用的别的文号也写进结论，
  // 文号总数因此不降反升，只查减少会漏掉这类新欠账（实测 6 个任务写回后平台待复查文号 0 → 7）。
  const unsourcedBefore = (prevRow?.docRefTotal ?? 0) - (prevRow?.docRefTraced ?? 0);
  const unsourcedAfter = (row?.docRefTotal ?? 0) - (row?.docRefTraced ?? 0);
  const newUnsourced = unsourcedAfter - unsourcedBefore;
  if (lostDocs > 0 || lostAmounts > 0) {
    // 写回只该增加出处，绝不该让文号或金额溯源项变少；变少就说明结论被整体重写了
    console.log(`  [警告] 这个任务的证据被改少了：文号 -${lostDocs} 处、金额溯源 -${lostAmounts} 项。`);
    console.log(
      `         多半是模型交回了改动说明而不是修订后的完整结论。回滚：pnpm writeback:evidence --restore ${p.task.id.slice(0, 8)}`,
    );
  }
  if (newUnsourced > 0) {
    // 这不是改坏，是新欠账：结论里多出现了没有出处的文号，跑一次文号批量复查即可补上
    console.log(
      `  [提示] 结论里新增了 ${newUnsourced} 处没有出处的文号（多为来源文件自己引用的其他文件）：在无出处的文号上跑一次「批量复查文号」即可补齐，不必回滚。`,
    );
  }
}
const done = snapshot();
console.log(`\n写回后：${line(done)}`);
console.log(
  `变化：文号有出处 ${delta(before.docRefTraced, done.docRefTraced)} · 文号总数 ${delta(
    before.docRefs,
    done.docRefs,
  )} · 引用 ${delta(before.citations, done.citations)} · 官方 ${delta(before.official, done.official)} · 弱 ${delta(
    before.weak,
    done.weak,
  )} · 金额待确认 ${delta(before.amountPending, done.amountPending)}`,
);
if (done.docRefTraced < before.docRefTraced || done.official < before.official) {
  console.log("[警告] 写回后证据反而变少：请逐个任务看「本次修订对证据的影响」与结论差异，别直接把这一轮当成果");
}
