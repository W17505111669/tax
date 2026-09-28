/**
 * 验证脚本：平台应用效果统计口径。
 * 重点是「记录级比对准确率」的两种口径（最近一次 / 累计）都与数据库独立重算一致，
 * 以及工具、任务、产物计数与 SQL / 目录聚合一致。
 * 运行：pnpm verify:stats
 */
import fs from "node:fs";
import path from "node:path";
import { computePlatformStats } from "../src/services/stats.ts";
import { db } from "../src/db.ts";
import { dirs } from "../src/config.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

const s = computePlatformStats();

// 1) 记录级比对：独立按时间顺序重算一遍
const calls = db
  .prepare(
    `SELECT result, started_at FROM tool_calls
     WHERE tool_name = 'compare_workpapers' AND ok = 1 AND task_id IN (SELECT id FROM tasks)
     ORDER BY started_at ASC`,
  )
  .all() as Array<{ result: string | null; started_at: string | null }>;
let runs = 0;
let matched = 0;
let compared = 0;
let latestAt = "";
let latestAcc: number | null = null;
for (const c of calls) {
  try {
    const p = JSON.parse(c.result ?? "") as {
      sheets?: Array<{ mode?: string }>;
      totals?: { accuracyPercent?: number; compared?: number; matched?: number };
    };
    if (p.sheets?.[0]?.mode !== "record" || p.totals?.accuracyPercent === undefined) continue;
    runs += 1;
    compared += p.totals.compared ?? 0;
    matched += p.totals.matched ?? 0;
    const at = String(c.started_at ?? "");
    if (at >= latestAt) {
      latestAt = at;
      latestAcc = p.totals.accuracyPercent;
    }
  } catch {
    // 忽略坏记录
  }
}
expect("记录级比对次数一致", s.compareRuns, runs);
expect("最近一次准确率按调用时间取值", s.compareAccuracy, latestAcc);
expect("最近一次时间戳一致", s.compareLatestAt, latestAt);
expect("累计一致项一致", s.compareMatched, matched);
expect("累计比对项一致", s.compareCompared, compared);
expect("累计准确率一致", s.compareAccuracyOverall, compared > 0 ? Math.round((matched / compared) * 10000) / 100 : null);
expect(
  "有比对记录时两种口径都必须有值",
  runs === 0 || (s.compareAccuracy !== null && s.compareAccuracyOverall !== null),
  true,
);

// 2) 工具计数与 SQL 聚合一致
const toolAgg = db
  .prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END), 0) AS ok
     FROM tool_calls WHERE task_id IN (SELECT id FROM tasks)`,
  )
  .get() as { n: number; ok: number };
expect("工具调用总数一致", s.toolCalls, toolAgg.n);
expect("工具成功数一致", s.toolOk, Number(toolAgg.ok));
expect("按工具分组求和等于总数", s.perTool.reduce((a, b) => a + b.calls, 0), s.toolCalls);
expect("按工具分组成功数求和一致", s.perTool.reduce((a, b) => a + b.ok, 0), s.toolOk);

// 3) 任务与产物计数
const taskAgg = db
  .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS c FROM tasks`)
  .get() as { n: number; c: number };
expect("任务总数一致", s.tasks, taskAgg.n);
expect("已完成数一致", s.completed, Number(taskAgg.c));
expect("按作品分组任务数之和等于总数", s.perAgent.reduce((a, b) => a + b.tasks, 0), s.tasks);
expect("按作品分组已完成之和等于总数", s.perAgent.reduce((a, b) => a + b.completed, 0), s.completed);

let art = 0;
for (const t of db.prepare(`SELECT id FROM tasks`).all() as Array<{ id: string }>) {
  const d = path.join(dirs.outputs, t.id);
  if (fs.existsSync(d)) art += fs.readdirSync(d).filter((f) => fs.statSync(path.join(d, f)).isFile()).length;
}
expect("产物计数与输出目录一致", s.artifacts, art);

// 4) 证据可信度口径：能与 SQL 独立对齐的部分必须完全一致，其余校验内部不变量
const ev = s.evidence;
const searchSql = db
  .prepare(
    `SELECT COUNT(*) AS n FROM tool_calls WHERE task_id IN (SELECT id FROM tasks)
       AND tool_name IN ('web_search','search_public_cases','fetch_content','fetch_public_document','get_search_content')`,
  )
  .get() as { n: number };
expect("检索调用数与 SQL 一致", ev.searchCalls, searchSql.n);
expect("检索两类之和等于调用数", ev.searchWithUrls + ev.searchMetadataOnly, ev.searchCalls);
expect("引用条数不多于检索留下的来源数", ev.citations <= ev.searchKept, true);
expect("官方引用不多于引用总数", ev.officialCitations <= ev.citations, true);
expect("弱证据引用不多于引用总数", ev.weakCitations <= ev.citations, true);
expect("文号可溯源与待复查不超过总数", ev.docRefTraced + ev.docRefPending <= ev.docRefs, true);
const matchedSql = db
  .prepare(
    `SELECT COUNT(*) AS n FROM ref_checks WHERE verdict = 'matched' AND task_id IN (SELECT id FROM tasks)`,
  )
  .get() as { n: number };
expect("复查到出处的处数与 SQL 一致", ev.docRefMatched, matchedSql.n);
expect("复查到出处的不超过无出处文号数", ev.docRefMatched <= ev.docRefs - ev.docRefTraced, true);
expect("缺口任务都有弱引用或待复查文号", ev.gaps.every((g) => g.weakCitations > 0 || g.docRefPending > 0), true);
expect(
  "缺口任务按缺口大小倒序",
  ev.gaps.every(
    (g, i) =>
      i === 0 ||
      (ev.gaps[i - 1]!.weakCitations + ev.gaps[i - 1]!.docRefPending) >= g.weakCitations + g.docRefPending,
  ),
  true,
);
const taskIds = new Set((db.prepare(`SELECT id FROM tasks`).all() as Array<{ id: string }>).map((t) => t.id));
expect("缺口任务都属于本平台", ev.gaps.every((g) => taskIds.has(g.id)), true);
expect(
  "缺口任务弱引用之和不超过全平台",
  ev.gaps.reduce((a, g) => a + g.weakCitations, 0) <= ev.weakCitations,
  true,
);
// 回算口径只在存在「过滤规则上线前、没有落库 dropped」的历史检索记录时才可能非 0
const legacy = (
  db
    .prepare(
      `SELECT result FROM tool_calls WHERE tool_name = 'search_public_cases' AND ok = 1 AND task_id IN (SELECT id FROM tasks)`,
    )
    .all() as Array<{ result: string | null }>
).filter((r) => {
  try {
    const d = JSON.parse(r.result ?? "{}") as { results?: unknown; dropped?: unknown };
    return Array.isArray(d.results) && typeof d.dropped !== "number";
  } catch {
    return false;
  }
}).length;
expect("过滤数非负", ev.searchDropped >= 0 && ev.searchDroppedReplay >= 0, true);
expect("没有历史未过滤记录时回算为 0", legacy > 0 || ev.searchDroppedReplay === 0, true);
expect("有历史未过滤记录时才回算", ev.searchDroppedReplay === 0 || legacy > 0, true);
console.log(
  `[verify] 证据可信度：检索 ${ev.searchCalls} 次（留来源 ${ev.searchWithUrls} / 仅元数据 ${ev.searchMetadataOnly}）· 引用 ${ev.citations} 条（官方 ${ev.officialCitations} · 弱 ${ev.weakCitations}）· 拦下无关结果 ${ev.searchDropped + ev.searchDroppedReplay} 条 · 文号 ${ev.docRefs} 处（可溯源 ${ev.docRefTraced} · 待复查 ${ev.docRefPending} · 已复查到出处 ${ev.docRefMatched}）· 缺口任务 ${ev.gaps.length} 个`,
);

console.log(
  `[verify] 平台统计检查项=${checks} 失败=${failures.length}（比对 ${runs} 次：最近 ${s.compareAccuracy ?? "n/a"}% / 累计 ${
    s.compareAccuracyOverall ?? "n/a"
  }%）`,
);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 平台统计口径不符");
  process.exit(1);
}
console.log("[PASS] 平台统计口径正确（比对双口径 / 工具 / 任务 / 产物）");
