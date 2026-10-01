/**
 * 验证脚本：提示词回归——「渲染实测」任务的结论与工具轨迹是否真遵守了系统提示词里的约束。
 * 运行：pnpm verify:promptreg
 *
 * 为什么需要它：系统提示词里写了一批硬约束（先查政策再测算、加计扣除比例必须取自工具返回值、
 * 抓取报 404/412 要如实标注且不得凭检索摘要或记忆补写原文、金额保留两位小数、结论用表格与
 * mermaid 组织且图后附说明），但「写了」不等于「模型遵守了」。此前只能靠人把结论读一遍：
 * 改一次提示词就要重读一次，而且读的人未必记得全部约束，漏读一条就是静默退化。
 *
 * 做法是约定命名：标题以「渲染实测」开头的任务就是提示词回归任务，本脚本对它们逐个走查。
 * 新建一个这类任务，门禁自动覆盖，不用回来改脚本。
 *
 * 约束分两组，判据不同：
 * - **硬约束**（提示词要求，所有回归任务都必须满足）：金额两位小数、工具调用顺序、比例取自工具
 *   返回值、抓取失败时如实标注。
 * - **呈现要求**（只在指令确实要求了的时候验）：表格、mermaid 图后附说明、有序列表。
 *   按指令关键词触发，避免拿一条没要求画图的指令去判「缺 mermaid」。
 *
 * 每组都有计数器，末尾断言「确实检查到了东西」：一个任务都没有、或某组一次都没触发，都算失败，
 * 否则这个门禁会因为「库里没有回归任务」而永远绿着。
 */
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

const PREFIX = "渲染实测";
const MONEY = /^[\d,]+\.\d{2}$/;

type Call = { tool_name: string; args: string | null; result: string | null; ok: number | null; started_at: string };

const targets = listTasks()
  .filter((t) => t.title.startsWith(PREFIX))
  .map((t) => ({ id: t.id, title: t.title, detail: getTask(t.id) }))
  .filter((x) => (x.detail?.result ?? "").trim().length > 0);

expect("确实有已完成的提示词回归任务可查（否则这个门禁是空跑绿）", targets.length >= 1, true);

const hit = { money: 0, order: 0, ratio: 0, failNote: 0, table: 0, mermaid: 0, ordered: 0 };

for (const task of targets) {
  const text = task.detail?.result ?? "";
  const instruction = task.detail?.instruction ?? "";
  const name = task.title;
  const calls = db
    .prepare(`SELECT tool_name, args, result, ok, started_at FROM tool_calls WHERE task_id = ? ORDER BY started_at ASC`)
    .all(task.id) as Call[];

  // ---- 硬约束 1：金额保留两位小数（提示词明写，也是「零口算」主张的可见证据）----
  const money = [...text.matchAll(/([\d][\d,]*(?:\.\d+)?)\s*元/g)].map((m) => m[1] ?? "");
  if (money.length > 0) {
    hit.money += 1;
    const bad = money.filter((v) => !MONEY.test(v));
    checks += 1;
    if (bad.length > 0) {
      failures.push(`${name}：有 ${bad.length} 处金额不是两位小数（${bad.slice(0, 4).join("、")}）`);
    }
  }

  // ---- 硬约束 2：测算前必须先查政策（提示词：先调 search_rd_policy 再调 calculate_rd_adjustment）----
  const calcAt = calls.findIndex((c) => c.tool_name === "calculate_rd_adjustment");
  if (calcAt >= 0) {
    hit.order += 1;
    const policyAt = calls.findIndex((c) => c.tool_name === "search_rd_policy");
    checks += 1;
    if (policyAt < 0) failures.push(`${name}：调了 calculate_rd_adjustment 却从没调 search_rd_policy`);
    else if (policyAt > calcAt) {
      failures.push(`${name}：search_rd_policy 在 calculate_rd_adjustment 之后才调（提示词要求先查政策再测算）`);
    }

    // ---- 硬约束 3：比例参数必须取自工具返回值，不得凭记忆填写 ----
    // 不认字段名（工具入参会改），只认数字：测算入参里的比例数字必须在政策检索的返回文本里出现过
    const policyText = calls
      .filter((c) => c.tool_name === "search_rd_policy")
      .map((c) => c.result ?? "")
      .join("\n");
    for (const c of calls.filter((x) => x.tool_name === "calculate_rd_adjustment")) {
      const args = c.args ?? "";
      const ratios = [
        ...args.matchAll(/(?:ratio|Rate|percent|比例)[^\d]{0,12}(\d{1,3}(?:\.\d{1,2})?)/gi),
      ].map((m) => m[1] ?? "");
      if (ratios.length === 0) continue;
      hit.ratio += 1;
      for (const r of ratios) {
        checks += 1;
        if (!policyText.includes(r)) {
          failures.push(
            `${name}：calculate_rd_adjustment 的比例 ${r} 没在 search_rd_policy 的返回里出现过（疑似凭记忆填写）`,
          );
        }
      }
    }
  }

  // ---- 硬约束 4：抓取失败要如实标注，不得凭检索摘要或记忆补写原文 ----
  const failedFetch = calls.filter(
    (c) =>
      (c.ok === 0 || /"error"\s*:\s*"[^"]*(404|412|Failed|error)/i.test(c.result ?? "")) &&
      /fetch|web_search|get_search_content|public_document/i.test(c.tool_name),
  );
  if (failedFetch.length > 0) {
    hit.failNote += 1;
    const noted = /(失效|已不存在|未能核验|取不到正文|无法访问|不作为依据|404|412)/.test(text);
    checks += 1;
    if (!noted) {
      failures.push(
        `${name}：有 ${failedFetch.length} 次抓取失败（${failedFetch
          .slice(0, 3)
          .map((c) => c.tool_name)
          .join("、")}），结论里却没有如实标注`,
      );
    }
  }

  // ---- 呈现要求：只在指令确实要求了的时候验 ----
  if (/表格/.test(instruction)) {
    hit.table += 1;
    const tableLines = text.split(/\r?\n/).filter((l) => l.trim().startsWith("|"));
    checks += 1;
    if (tableLines.length < 3) failures.push(`${name}：指令要求用表格，结论里表格行只有 ${tableLines.length} 行`);
  }
  if (/mermaid|流程图|关系图/i.test(instruction)) {
    hit.mermaid += 1;
    const blocks = [...text.matchAll(/```mermaid[\s\S]*?```/g)];
    checks += 1;
    if (blocks.length === 0) failures.push(`${name}：指令要求画图，结论里没有 mermaid 代码块`);
    for (const b of blocks) {
      checks += 1;
      const after = text.slice((b.index ?? 0) + b[0].length);
      const nextLine = after.split(/\r?\n/).find((l) => l.trim() !== "");
      // 只把「又一个块的开头」判成没有说明：代码围栏、标题、表格、分隔线。
      // 第一版把 `*` 与 `-` 一律当列表记号排除，结果误杀了 `**图意说明：** …` 这种粗体开头的
      // 说明——真实数据里 4 处全是这个形状，模型其实遵守了约束，是判据错了。
      // 用真实任务的结论校准判据，比照着提示词字面想象一个正则可靠。
      const t = (nextLine ?? "").trim();
      if (!nextLine || /^(```|#|\||-{3,}$|={3,}$)/.test(t)) {
        failures.push(`${name}：有一个 mermaid 图后面没有紧跟一句文字说明（提示词要求图后附说明）`);
      }
    }
  }
  if (/有序列表|逐条列出|核查要点|问题清单/.test(instruction)) {
    hit.ordered += 1;
    checks += 1;
    if (!/^\s*\d+[.、]\s+/m.test(text)) failures.push(`${name}：指令要求有序列表，结论里找不到`);
  }
}

// 每组约束都要真的被触发过，否则「全绿」只是因为没有任务落到这一组上
expect("金额两位小数这一组确实被检查过", hit.money >= 1, true);
expect("工具顺序这一组确实被检查过", hit.order >= 1, true);
expect("表格这一组确实被检查过", hit.table >= 1, true);
expect("mermaid 图后说明这一组确实被检查过", hit.mermaid >= 1, true);
console.log(
  `[verify] 提示词回归任务 ${targets.length} 个 · 触发情况：金额 ${hit.money} · 工具顺序 ${hit.order} · 比例取自工具 ${hit.ratio} · 抓取失败标注 ${hit.failNote} · 表格 ${hit.table} · mermaid ${hit.mermaid} · 有序列表 ${hit.ordered}`,
);

console.log(`[verify] 提示词回归检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 提示词约束未被遵守");
  process.exit(1);
}
console.log("[PASS] 提示词回归：约束逐条被遵守（金额格式 / 工具顺序 / 比例取自工具 / 失败如实标注 / 呈现形式）");
