/**
 * 修复脚本：把 tool_end 事件重新配对回 tool_calls 行。
 *
 * 起因是 agent-runner 按**工具名**配对开始与结束事件：同名工具在上一次还没结束就再次开始时，
 * 后一次的行 id 覆盖前一次，于是（1）前一行永远停在 ok IS NULL、result 为空，（2）结束时取到的是
 * 另一次的行 id，结果被挂到错误的调用上。实测 270 次 tool_start / 270 次 tool_end 一一成对，却只有
 * 233 行写了结果；丢掉的 37 行恰好等于「同名工具未结束就再次开始」的次数。
 *
 * 结果并没有真的丢——tool_end 事件的 payload 里带着完整 result，所以这是**恢复被错配的数据**，
 * 不是回填编造的数值。
 *
 * 配对不能用「按开始顺序结束」：试算时这条假设当场被推翻，14 条结果回显的入参与所在行的 args
 * 对不上，而且都是成对互换（fetch_public_document 第 1 次拿到第 2 次的 url，反之亦然），说明同名
 * 工具的结束顺序与开始顺序不一致。改用两级配对：
 *   1) 硬证据优先——结果里回显了入参的工具（calculate_rd_adjustment / check_rd_expenses 的
 *      projectName、检索类的 query、抓取类的 url）按该字段精确匹配到唯一一行；
 *   2) 剩下的（结果不回显入参、或同组内取值相同无法区分）按顺序兜底配对。
 *
 * ok 按新判据重算：事件 payload 里的 ok 是旧代码写的（读错了 isError 的位置，270 条全是 true），
 * 不可信；改为看 result 里有没有非空 error 字符串。事件顶层的 isError 没有落进 payload，无法追溯，
 * 这是本次恢复能拿到的全部信号，如实说明。
 *
 * ended_at 只在行本来为空时补：已有值的行是 finishToolCall 落库的时刻，与事件时刻本就差一两毫秒，
 * 拿事件时间去覆盖只是制造无意义的改动（试算时 252 行「需改动」里绝大多数是这种毫秒差）。
 *
 * 运行：pnpm repair:toolcalls            只试算，逐条列出将改动的行
 *      pnpm repair:toolcalls --apply    真正写库（幂等，已一致的行不动）
 */
import { db } from "../src/db.ts";

const apply = process.argv.includes("--apply");

interface Row {
  id: string;
  task_id: string;
  tool_name: string;
  args: string | null;
  result: string | null;
  ok: number | null;
  started_at: string | null;
  ended_at: string | null;
}
interface Ev {
  at: string;
  toolName: string;
  result: unknown;
  hadCallId: boolean;
}

const rows = db
  .prepare(
    `SELECT id, task_id, tool_name, args, result, ok, started_at, ended_at FROM tool_calls ORDER BY started_at ASC, rowid ASC`,
  )
  .all() as unknown as Row[];
const events = db
  .prepare(`SELECT task_id, seq, payload, at FROM events WHERE kind = 'tool_end' ORDER BY task_id, seq ASC`)
  .all() as unknown as Array<{ task_id: string; seq: number; payload: string | null; at: string }>;

const ends: Array<Ev & { task_id: string }> = [];
for (const e of events) {
  let p: any = null;
  try {
    p = JSON.parse(e.payload ?? "null");
  } catch {
    p = null;
  }
  if (!p || typeof p !== "object") continue;
  ends.push({
    task_id: e.task_id,
    at: e.at,
    toolName: String(p.toolName ?? ""),
    result: p.result ?? null,
    hadCallId: typeof p.callId === "string" && p.callId !== "",
  });
}

/** 结果里带非空 error 字符串即视为失败：社区联网工具用 details.error 报失败而不置 isError */
function okFromResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return true;
  const err = (result as { error?: unknown }).error;
  return !(typeof err === "string" && err.trim() !== "");
}

/**
 * 哪些工具的结果会**原样回显**某个入参字段——只有这种字段能当配对的硬证据。实测：
 * calculate_rd_adjustment / check_rd_expenses 回显 projectName，search_public_cases 回显 query，
 * fetch_public_document 回显 url。
 *
 * 不能想当然按字段名猜：get_search_content 的入参是 {responseId, urlIndex}，结果里的 url 是由
 * 这两个参数推出来的，不是入参回显；fetch_content 的结果给的是 urls 数组而不是 url。把这两个也
 * 当证据，试算时立刻冒出 34 条「结果回显的 url 没有任何一行的 args 与之相符」的假冲突。
 */
const ECHO_FIELD: Record<string, string> = {
  calculate_rd_adjustment: "projectName",
  check_rd_expenses: "projectName",
  search_public_cases: "query",
  fetch_public_document: "url",
};

/** 结果回显了哪个入参字段（配对的硬证据）；返回 null 表示这个工具无法验证，只能顺序兜底 */
function echoedInput(toolName: string, result: unknown): { field: string; value: string } | null {
  const field = ECHO_FIELD[toolName];
  if (!field) return null;
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;
  const d = (typeof r.details === "object" && r.details !== null ? r.details : r) as Record<string, unknown>;
  const v = d[field];
  return typeof v === "string" && v !== "" ? { field, value: v } : null;
}

function argField(row: Row, field: string): string | null {
  try {
    const v = (JSON.parse(row.args ?? "null") as Record<string, unknown> | null)?.[field];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

const rowsByKey = new Map<string, Row[]>();
for (const r of rows) {
  const k = `${r.task_id}|${r.tool_name}`;
  rowsByKey.set(k, [...(rowsByKey.get(k) ?? []), r]);
}
const endsByKey = new Map<string, Array<Ev & { task_id: string }>>();
for (const e of ends) {
  const k = `${e.task_id}|${e.toolName}`;
  endsByKey.set(k, [...(endsByKey.get(k) ?? []), e]);
}

let countMismatch = 0;
let changed = 0;
let filledNull = 0;
let okFlipped = 0;
let resultMoved = 0;
let byEcho = 0;
let byOrder = 0;
let echoAmbiguous = 0;
let echoConflict = 0;
const changes: string[] = [];
const problems: string[] = [];

for (const k of [...new Set([...rowsByKey.keys(), ...endsByKey.keys()])].sort()) {
  const rs = rowsByKey.get(k) ?? [];
  const es = endsByKey.get(k) ?? [];
  const taskPrefix = k.split("|")[0]!.slice(0, 8);
  const toolName = k.split("|")[1]!;
  if (rs.length !== es.length) {
    countMismatch += 1;
    problems.push(`${taskPrefix} ${toolName}：调用行 ${rs.length} 条对结束事件 ${es.length} 条，本组不动`);
    continue;
  }

  // 1) 硬证据配对：结果回显的入参唯一命中某一行
  const pair = new Map<number, number>();
  const byEchoIdx = new Set<number>();
  const usedEvents = new Set<number>();
  for (let ei = 0; ei < es.length; ei += 1) {
    const echo = echoedInput(toolName, es[ei]!.result);
    if (!echo) continue;
    const hits: number[] = [];
    for (let ri = 0; ri < rs.length; ri += 1) {
      if (pair.has(ri)) continue;
      if (argField(rs[ri]!, echo.field) === echo.value) hits.push(ri);
    }
    if (hits.length === 1) {
      pair.set(hits[0]!, ei);
      byEchoIdx.add(ei);
      usedEvents.add(ei);
      byEcho += 1;
    } else if (hits.length > 1) {
      echoAmbiguous += 1; // 同组内入参取值相同，无法区分，交给顺序兜底
    } else {
      echoConflict += 1;
      problems.push(
        `${taskPrefix} ${toolName}：某次结果回显 ${echo.field}="${echo.value.slice(0, 48)}"，但没有任何一行的 args 与之相符`,
      );
    }
  }
  // 2) 其余按顺序兜底
  const freeRows = rs.map((_, i) => i).filter((i) => !pair.has(i));
  const freeEvents = es.map((_, i) => i).filter((i) => !usedEvents.has(i));
  freeRows.forEach((ri, n) => {
    const ei = freeEvents[n];
    if (ei !== undefined) {
      pair.set(ri, ei);
      byOrder += 1;
    }
  });

  for (const [ri, ei] of [...pair.entries()].sort((a, b) => a[0] - b[0])) {
    const row = rs[ri]!;
    const ev = es[ei]!;
    const wantOk = okFromResult(ev.result) ? 1 : 0;
    const wantResult = ev.result === null || ev.result === undefined ? null : JSON.stringify(ev.result);
    const currentResult =
      row.result === null || row.result === undefined || row.result === "" ? null : String(row.result);
    // ended_at 只在本来为空时补，已有值的不覆盖（与事件时刻本就差一两毫秒）
    const wantEnded =
      row.ended_at === null || row.ended_at === undefined || row.ended_at === "" ? ev.at : row.ended_at;

    const sameOk = row.ok === wantOk;
    const sameResult = currentResult === wantResult;
    const sameEnded = String(row.ended_at ?? "") === String(wantEnded ?? "");
    if (sameOk && sameResult && sameEnded) continue;

    changed += 1;
    if (row.ok === null) filledNull += 1;
    if (row.ok !== null && row.ok !== wantOk) okFlipped += 1;
    if (!sameResult && currentResult !== null) resultMoved += 1;
    if (changes.length < 30) {
      changes.push(
        `${taskPrefix} ${toolName} 第 ${ri + 1} 次（依据：${byEchoIdx.has(ei) ? "结果回显入参" : "顺序兜底"}）：ok ${String(
          row.ok,
        )} → ${wantOk}｜结果 ${currentResult === null ? "空" : `${currentResult.length} 字`} → ${
          wantResult === null ? "空" : `${wantResult.length} 字`
        }${sameEnded ? "" : `｜补 ended_at`}｜事件曾配对=${ev.hadCallId}`,
      );
    }

    if (apply) {
      db.prepare(`UPDATE tool_calls SET ok = ?, result = ?, ended_at = ? WHERE id = ?`).run(
        wantOk,
        wantResult,
        wantEnded,
        row.id,
      );
    }
  }
}

console.log(`${apply ? "已写库" : "试算"}：调用行 ${rows.length} · 结束事件 ${ends.length}`);
console.log(
  `配对依据：硬证据（结果回显入参）${byEcho} 条 · 顺序兜底 ${byOrder} 条（其中同组入参重复无法区分 ${echoAmbiguous} 条）`,
);
console.log(
  `需改动 ${changed} 行：补上从未落库的结果 ${filledNull} · ok 由 1 改 0 共 ${okFlipped} · 结果被挪到正确的行 ${resultMoved}`,
);
if (problems.length > 0) {
  console.log(`\n问题 ${problems.length} 条：`);
  for (const p of problems.slice(0, 15)) console.log(`  - ${p}`);
}
if (changes.length > 0) {
  console.log(`\n改动明细（前 ${changes.length} 条）：`);
  for (const c of changes) console.log(`  - ${c}`);
}
if (countMismatch > 0) console.log(`\n[WARN] ${countMismatch} 组行数与事件数不一致，已跳过`);
if (!apply && changed > 0) console.log("\n确认无误后加 --apply 写库（幂等，已一致的行不动）");
if (echoConflict > 0 || countMismatch > 0) {
  console.log("\n[FAIL] 存在无法解释的配对，不写库");
  process.exit(1);
}
