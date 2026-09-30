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
 */
import { runTask } from "../src/services/agent-runner.ts";
import { listRefChecks } from "../src/services/ref-checks.ts";
import { getTask, listTasks } from "../src/services/task-store.ts";
import { computePlatformStats } from "../src/services/stats.ts";
import { buildRevisionInstruction, toRevisionItems } from "../../web/src/ref-check.ts";

const args = process.argv.slice(2);
const doRun = args.includes("--run");
const doPrint = args.includes("--print");
const at = args.indexOf("--task");
const taskFilter = at >= 0 ? (args[at + 1] ?? "") : "";

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
    // 已经写回的不再进指令：结论正文里出现过这条证据地址，就说明上一轮续跑已经补上了。
    // 只对有证据地址的素材这样判断（「标注未取得原文」那类没有地址可比，仍会列出，由人工决定）。
    const items = toRevisionItems(listRefChecks(t.id)).filter(
      (i) => i.verdict !== "matched" || !i.evidence || !result.includes(i.evidence.url),
    );
    return { task: t, items, instruction: buildRevisionInstruction(items) };
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
    } · 指令 ${p.instruction.length} 字`,
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
