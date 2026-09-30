/**
 * 验证脚本：平台应用效果统计口径。
 * 重点是「记录级比对准确率」的两种口径（最近一次 / 累计）都与数据库独立重算一致，
 * 以及工具、任务、产物计数与 SQL / 目录聚合一致。
 * 运行：pnpm verify:stats
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computePlatformStats } from "../src/services/stats.ts";
import { db } from "../src/db.ts";
import { dirs } from "../src/config.ts";
import { compareRates } from "@tax/document-tools";
import {
  aggregatePeerCompares,
  buildDerivedFrom,
  isTemplateCompare,
  summarizeTaskCompares,
} from "../src/services/compare-stats.ts";
import { docRefSnapshotText, evidenceSnapshotText } from "./materials-lib.ts";

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
    `SELECT task_id, args, result, started_at FROM tool_calls
     WHERE tool_name = 'compare_workpapers' AND ok = 1 AND task_id IN (SELECT id FROM tasks)
     ORDER BY started_at ASC`,
  )
  .all() as Array<{ task_id: string; args: string | null; result: string | null; started_at: string | null }>;
let runs = 0;
let matched = 0;
let compared = 0;
let mismatched = 0;
let onlyA = 0;
let onlyB = 0;
let matchedAll = 0;
let comparedAll = 0;
let templateRuns = 0;
let templateFilled = 0;
let templateMismatched = 0;
// 「哪次比对是跟自己的原始模板比」这条分类规则与平台共用一份实现（靠产物溯源判定，不靠文件名猜）；
// 但下面的累计仍由本脚本独立按 SQL 时间顺序重算一遍，专门用来抓平台侧的漂移
const argsByTask = new Map<string, Array<{ args: string | null }>>();
for (const row of db
  .prepare(`SELECT task_id, args FROM tool_calls WHERE args IS NOT NULL AND task_id IN (SELECT id FROM tasks)`)
  .all() as Array<{ task_id: string; args: string | null }>) {
  const list = argsByTask.get(row.task_id);
  if (list) list.push(row);
  else argsByTask.set(row.task_id, [row]);
}
const derivedCache = new Map<string, Map<string, string>>();
const derivedOf = (taskId: string): Map<string, string> => {
  const hit = derivedCache.get(taskId);
  if (hit) return hit;
  const built = buildDerivedFrom(argsByTask.get(taskId) ?? []);
  derivedCache.set(taskId, built);
  return built;
};
// 累计口径按「每个任务最近一次记录级比对」合计：同任务反复比对时只有最近一次代表当前状态
const perTask = new Map<
  string,
  { at: string; matched: number; compared: number; mismatched: number; onlyA: number; onlyB: number }
>();
let latestAt = "";
let latestAcc: number | null = null;
let latestRates: { matchRatePercent: number | null; coveragePercent: number | null } = {
  matchRatePercent: null,
  coveragePercent: null,
};
for (const c of calls) {
  try {
    const p = JSON.parse(c.result ?? "") as {
      sheets?: Array<{ mode?: string }>;
      totals?: {
        accuracyPercent?: number;
        compared?: number;
        matched?: number;
        mismatched?: number;
        onlyA?: number;
        onlyB?: number;
      };
    };
    if (p.sheets?.[0]?.mode !== "record" || p.totals?.accuracyPercent === undefined) continue;
    // 与自己的原始模板核对：只有一侧有的格子正是填进去的值，不进一致率与覆盖率
    if (isTemplateCompare(c.args, derivedOf(c.task_id))) {
      templateRuns += 1;
      templateFilled += p.totals.onlyA ?? 0;
      templateMismatched += p.totals.mismatched ?? 0;
      continue;
    }
    runs += 1;
    const at = String(c.started_at ?? "");
    comparedAll += p.totals.compared ?? 0;
    matchedAll += p.totals.matched ?? 0;
    const prev = perTask.get(c.task_id);
    if (!prev || at >= prev.at) {
      perTask.set(c.task_id, {
        at,
        matched: p.totals.matched ?? 0,
        compared: p.totals.compared ?? 0,
        mismatched: p.totals.mismatched ?? 0,
        onlyA: p.totals.onlyA ?? 0,
        onlyB: p.totals.onlyB ?? 0,
      });
    }
    if (at >= latestAt) {
      latestAt = at;
      latestAcc = p.totals.accuracyPercent;
      // 比率按原始计数现算，不读记录里的字段：拆分上线前的旧记录没有这两个字段
      latestRates = compareRates(p.totals.matched ?? 0, p.totals.mismatched ?? 0, p.totals.onlyA ?? 0);
    }
  } catch {
    // 忽略坏记录
  }
}
for (const v of perTask.values()) {
  matched += v.matched;
  compared += v.compared;
  mismatched += v.mismatched;
  onlyA += v.onlyA;
  onlyB += v.onlyB;
}
expect("记录级比对次数一致", s.compareRuns, runs);
expect("与原始模板核对的次数一致", s.compareTemplateRuns, templateRuns);
expect("填列新增单元格数一致", s.compareFilledCells, templateFilled);
expect("与模板既有内容冲突数一致", s.compareTemplateMismatched, templateMismatched);
// 分类与合计的单元口径：合成调用就能覆盖，不依赖真实数据里恰好存在哪一种比对
const cmpCall = (args: unknown, totals: unknown, mode: string, at: string) => ({
  tool_name: "compare_workpapers",
  ok: 1 as number | null,
  args: JSON.stringify(args),
  result: JSON.stringify({ sheets: [{ mode }], totals }),
  started_at: at,
});
const fillCall = {
  tool_name: "fill_land_vat_workpaper",
  ok: 1 as number | null,
  args: JSON.stringify({ fileName: "土增清算底稿-合成模板.xlsx", outputName: "已填列-土增清算底稿-合成模板.xlsx" }),
  result: null,
  started_at: "2026-09-29T01:00:00.000Z",
};
const derived = buildDerivedFrom([fillCall]);
expect(
  "b 侧正是 a 的生成源 → 判为与自己的模板核对",
  isTemplateCompare(
    JSON.stringify({ a: { name: "已填列-土增清算底稿-合成模板.xlsx" }, b: { name: "土增清算底稿-合成模板.xlsx" } }),
    derived,
  ),
  true,
);
expect(
  "b 侧是别的上传件（人工参考底稿）→ 仍算同行评审，不按 kind 猜",
  isTemplateCompare(
    JSON.stringify({ a: { kind: "artifact", name: "自动底稿.xlsx" }, b: { kind: "upload", name: "人工参考底稿.xlsx" } }),
    derived,
  ),
  false,
);
const synthetic = [
  fillCall,
  cmpCall(
    { a: { kind: "artifact", name: "已填列-土增清算底稿-合成模板.xlsx" }, b: { kind: "upload", name: "土增清算底稿-合成模板.xlsx" } },
    { compared: 16, matched: 4, mismatched: 0, onlyA: 12, onlyB: 0, accuracyPercent: 25 },
    "record",
    "2026-09-29T02:00:00.000Z",
  ),
  cmpCall(
    { a: { kind: "artifact", name: "自动底稿.xlsx" }, b: { kind: "upload", name: "人工参考底稿.xlsx" } },
    { compared: 3, matched: 2, mismatched: 1, onlyA: 0, onlyB: 0, accuracyPercent: 66.67 },
    "record",
    "2026-09-29T03:00:00.000Z",
  ),
  cmpCall(
    { a: { kind: "artifact", name: "自动底稿.xlsx" }, b: { kind: "upload", name: "人工参考底稿.xlsx" } },
    { compared: 2, matched: 1, mismatched: 1, onlyA: 0, onlyB: 0, accuracyPercent: 50 },
    "record",
    "2026-09-28T03:00:00.000Z",
  ),
];
const summary = summarizeTaskCompares(synthetic);
expect("模板核对单独归类，不混进行评审", summary.template.runs, 1);
expect("填列新增取自 onlyA", summary.template.filledCells, 12);
expect("同行评审只取最近一次", summary.peer?.compared, 3);
expect("同行评审次数照实计（含被后来那次取代的）", summary.peerRuns, 2);
expect(
  "逐格（address）模式不进记录级口径：量纲不同，混在一起没法解释",
  summarizeTaskCompares([
    cmpCall(
      { a: { name: "x.xlsx" }, b: { name: "y.xlsx" } },
      { compared: 28, matched: 16, mismatched: 0, onlyA: 12, onlyB: 0, accuracyPercent: 57.14 },
      "address",
      "2026-09-29T04:00:00.000Z",
    ),
  ]).peer,
  null,
);
const agg = aggregatePeerCompares([summary.peer]);
expect("合计一致率按原始计数现算", agg.matchRatePercent, 66.67);
expect("合计覆盖率按原始计数现算", agg.coveragePercent, 100);
expect("合计只含同行评审那一次", agg.compared, 3);
expect("最近一次准确率按调用时间取值", s.compareAccuracy, latestAcc);
expect("最近一次时间戳一致", s.compareLatestAt, latestAt);
expect("累计一致项一致", s.compareMatched, matched);
expect("累计比对项一致", s.compareCompared, compared);
expect("累计准确率一致", s.compareAccuracyOverall, compared > 0 ? Math.round((matched / compared) * 10000) / 100 : null);
// 构成与两个拆分比率：一致率只看两边都有的项（填得对不对），覆盖率看人工底稿有的项自动填到多少（填得全不全）
const overallRates = compareRates(matched, mismatched, onlyA);
expect("构成相加等于累计比对项", matched + mismatched + onlyA + onlyB, compared);
expect("累计填错项一致", s.compareMismatched, mismatched);
expect("累计仅人工底稿有项一致", s.compareOnlyA, onlyA);
expect("累计仅自动底稿有项一致", s.compareOnlyB, onlyB);
expect("累计一致率一致", s.compareMatchRateOverall, overallRates.matchRatePercent);
expect("累计覆盖率一致", s.compareCoverageOverall, overallRates.coveragePercent);
expect("最近一次一致率一致", s.compareMatchRate, latestRates.matchRatePercent);
expect("最近一次覆盖率一致", s.compareCoverage, latestRates.coveragePercent);
console.log(
  `[verify] 记录级比对构成：一致 ${matched} · 填错 ${mismatched} · 仅人工底稿有 ${onlyA} · 仅自动底稿有 ${onlyB}；一致率 ${
    overallRates.matchRatePercent ?? "无可比对项"
  }% · 覆盖率 ${overallRates.coveragePercent ?? "无可比对项"}% · 总准确率 ${s.compareAccuracyOverall ?? "—"}%`,
);
expect("累计口径的任务数不超过比对次数", perTask.size <= runs, true);
if (perTask.size < runs) {
  // 有任务比对过不止一次：累计必须只算最近一次，否则一次失败的重复比对会永久拉低准确率
  expect("存在重复比对时累计小于全部相加", compared < comparedAll, true);
  expect("重复比对时一致项也按最近一次取", matched <= matchedAll, true);
}
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
expect("工具留存的引用不多于检索留下的来源数", ev.citationsFromTools <= ev.searchKept, true);
expect("引用来源两项之和等于总数", ev.citationsFromTools + ev.citationsFromConclusion, ev.citations);
expect("官方与弱证据都不多于引用总数", ev.officialCitations <= ev.citations && ev.weakCitations <= ev.citations, true);
expect("官方引用不多于引用总数", ev.officialCitations <= ev.citations, true);
expect("弱证据引用不多于引用总数", ev.weakCitations <= ev.citations, true);
expect("已找到替代来源的不多于弱证据数", ev.weakWithReplacement <= ev.weakCitations, true);
expect("已声明为背景参考的不多于弱证据数", ev.weakDisclaimed <= ev.weakCitations, true);
expect("已标注的文号不超过待复查数", ev.docRefLabeled <= ev.docRefPending, true);
expect("未进结论正文的不多于弱证据数", ev.weakUncited <= ev.weakCitations, true);
expect(
  "已声明与未进结论两类不重叠，加起来不超过弱证据总数",
  ev.weakDisclaimed + ev.weakUncited <= ev.weakCitations,
  true,
);
const replacedSql = db
  .prepare(
    `SELECT COUNT(*) AS n FROM ref_checks WHERE kind = 'citation' AND verdict = 'matched' AND task_id IN (SELECT id FROM tasks)`,
  )
  .get() as { n: number };
expect(
  "替代来源计数不多于落库的 matched 记录",
  ev.weakWithReplacement <= replacedSql.n,
  true,
);
expect("文号可溯源与待复查不超过总数", ev.docRefTraced + ev.docRefPending <= ev.docRefs, true);
const matchedSql = db
  .prepare(
    // 与 stats 同口径：文号复查统计排除引用类记录（kind <> 'citation'）
    `SELECT COUNT(*) AS n FROM ref_checks WHERE verdict = 'matched' AND kind <> 'citation' AND task_id IN (SELECT id FROM tasks)`,
  )
  .get() as { n: number };
expect("复查到出处的处数与 SQL 一致", ev.docRefMatched, matchedSql.n);
// 「复查到出处」是复查记录里判为 matched 的条数：写回结论之后那些文号会变成可溯源、
// 不再计入无出处，但复查记录还在，所以它可以大于当前无出处文号数（实测 19 > 16）。
// 真正成立的不变量是待复查不超过无出处总数（待复查 = 无出处 − 已复查到出处，逐任务不小于 0）。
expect("待复查不超过无出处文号数", ev.docRefPending <= ev.docRefs - ev.docRefTraced, true);
expect("复查到出处为非负数", ev.docRefMatched >= 0, true);
expect("可溯源文号不超过文号总数", ev.docRefTraced <= ev.docRefs, true);
expect("缺口任务都有弱引用或待复查文号", ev.gaps.every((g) => g.weakCitations > 0 || g.docRefPending > 0), true);
// 已在结论里声明「仅作背景参考，不作为政策依据」的弱引用不是欠账：缺口清单里每个任务都得还真有
// 待处置的项，否则看板与作品说明会一直催一件已经做完的事（实测 eb75f4fb 5 条弱引用全部已声明，
// 却仍挂在缺口清单里，缺口任务数因此虚报 5 个而不是 4 个）
expect(
  "缺口任务都还有待处置的弱引用或待复查文号",
  ev.gaps.every(
    (g) =>
      g.weakCitations - g.weakDisclaimed - g.weakUncited > 0 || g.docRefPending - g.docRefLabeled > 0,
  ),
  true,
);
expect("缺口构成里的已声明数不超过该任务弱引用数", ev.gaps.every((g) => g.weakDisclaimed <= g.weakCitations), true);
expect(
  "缺口构成里两类之和不超过该任务弱引用数",
  ev.gaps.every((g) => g.weakDisclaimed + g.weakUncited <= g.weakCitations),
  true,
);
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
  `[verify] 证据可信度：检索 ${ev.searchCalls} 次（留来源 ${ev.searchWithUrls} / 仅元数据 ${ev.searchMetadataOnly}）· 引用 ${ev.citations} 条（工具留存 ${ev.citationsFromTools} + 结论正文 ${ev.citationsFromConclusion}；官方 ${ev.officialCitations} · 弱 ${ev.weakCitations}，其中 ${ev.weakWithReplacement} 条已找到替代来源、${ev.weakDisclaimed} 条已在结论中声明为背景参考、${ev.weakUncited} 条未进入结论正文）· 拦下无关结果 ${ev.searchDropped + ev.searchDroppedReplay} 条 · 文号 ${ev.docRefs} 处（可溯源 ${ev.docRefTraced} · 待复查 ${ev.docRefPending} · 已复查到出处 ${ev.docRefMatched}）· 缺口任务 ${ev.gaps.length} 个`,
);

// 交付文档必须与实时数据同源：作品说明里的口径串由生成器在生成时取数拼出。
// 一旦有人把数字写死回散文里，或者数据变了却没重生成，这里就会失败——作品说明自己写着
// 「看板与交付材料不会对不上」，这句话不能由同一份文档里的另一段来打脸。
const statsHere = path.dirname(fileURLToPath(import.meta.url));
const competitionDir = path.join(path.resolve(statsHere, "..", "..", ".."), "docs", "competition");
const materialDocs = fs.existsSync(competitionDir)
  ? fs.readdirSync(competitionDir).filter((n) => n.endsWith("-作品说明.md"))
  : [];
expect("作品说明文档存在", materialDocs.length >= 2, true);
for (const f of materialDocs) {
  const text = fs.readFileSync(path.join(competitionDir, f), "utf8");
  for (const snap of [evidenceSnapshotText(), docRefSnapshotText()]) {
    // 不同源时这里会失败，处理办法是跑 pnpm gen:materials 后连同数据一起提交
    expect(`${f} 含实时口径「${snap.slice(0, 20)}…」`, text.includes(snap), true);
  }
}

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
