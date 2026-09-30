/**
 * 验证脚本：工具调用三态口径（成功 / 失败 / 未返回）。
 *
 * `ok IS NULL` 是「调用发起了但从未返回」——进程在工具返回前就没了（服务重启打断），result 与
 * ended_at 都是空。看板此前用 `总数 - 成功数` 当失败数，把这 37 次算成工具报错：成功率从 100%
 * 被压到 86.3%，还让人去查一个根本不存在的错误。任务页的 callStats 早就把 ok===null 单列了，
 * 平台侧没接上——同一个判据两个消费点各改一次、漏一个，是这个仓库反复踩的坑，所以口径收成一份
 * 纯函数并单独进门禁。
 *
 * 运行：pnpm verify:toutcome
 */
import {
  countsAreConsistent,
  outcomeLine,
  resolvedCalls,
  ringSegments,
  successRate,
  type ToolOutcomeCounts,
} from "../../web/src/tool-outcome.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computePlatformStats } from "../src/services/stats.ts";
import { db } from "../src/db.ts";

const failures: string[] = [];
let checks = 0;

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

/** 修复前的平台真实快照：233 成功、0 失败、37 行没有结果落库。留作固定样例，不随库变动 */
const REAL: ToolOutcomeCounts = { calls: 270, ok: 233, failed: 0, unfinished: 37 };
const MIXED: ToolOutcomeCounts = { calls: 10, ok: 8, failed: 2, unfinished: 0 };
const ALL_UNFINISHED: ToolOutcomeCounts = { calls: 5, ok: 0, failed: 0, unfinished: 5 };
const EMPTY: ToolOutcomeCounts = { calls: 0, ok: 0, failed: 0, unfinished: 0 };

// 1) 分母只取有返回结果的调用
expect("分母 = 成功 + 失败，未返回不进分母", resolvedCalls(REAL), 233);
expect("无未返回时分母等于总数", resolvedCalls(MIXED), 10);
expect("全部未返回时分母为 0", resolvedCalls(ALL_UNFINISHED), 0);

// 2) 成功率：算得出就给两位小数，算不出给 null（由调用方显示「—」，不填 0 也不填 100）
expect("全成功即 100%", successRate(REAL), 100);
expect("有失败时按有结果的调用算", successRate(MIXED), 80);
expect("一次有结果的调用都没有时为 null", successRate(ALL_UNFINISHED), null);
expect("零调用时为 null", successRate(EMPTY), null);
expect(
  "不把未返回算进分母：否则 100% 会被压成 86.3%",
  [successRate(REAL), Math.round((REAL.ok / REAL.calls) * 1000) / 10],
  [100, 86.3],
);
expect("两位小数四舍五入", successRate({ calls: 3, ok: 2, failed: 1, unfinished: 0 }), 66.67);

// 3) 三态自洽性：总数必须恰好等于三态之和
expect("自洽的计数判为一致", [countsAreConsistent(REAL), countsAreConsistent(MIXED), countsAreConsistent(EMPTY)], [
  true,
  true,
  true,
]);
expect("总数对不上时判为不一致（出现了第四种 ok 取值）", countsAreConsistent({ calls: 9, ok: 8, failed: 2, unfinished: 0 }), false);

// 4) 环图三段弧：长度按总数分配、偏移首尾相接、零调用不产生 NaN
const C = 100;
const segs = ringSegments(REAL, C);
expect("三段弧，顺序为 成功 → 失败 → 未返回", segs.map((s) => s.key), ["ok", "failed", "unfinished"]);
expect("三段弧长之和等于周长", Math.round(segs.reduce((a, s) => a + s.length, 0) * 1e6) / 1e6, C);
expect("成功段弧长占比", Math.round(segs[0]!.length * 100) / 100, Math.round((233 / 270) * 10000) / 100);
expect("失败为 0 时该段弧长为 0（不画也不占位）", segs[1]!.length, 0);
expect("偏移首尾相接", [segs[0]!.offset, Math.round(segs[2]!.offset * 100) / 100], [0, -Math.round((233 / 270) * C * 100) / 100]);
expect("零调用时三段弧长全为 0、无 NaN", ringSegments(EMPTY, C).map((s) => s.length), [0, 0, 0]);
expect(
  "零调用时偏移也无 NaN",
  ringSegments(EMPTY, C).every((s) => Number.isFinite(s.offset)),
  true,
);

// 5) 一行文字口径：三态都摆出来，未返回只在真有的时候出现
const line = outcomeLine(REAL);
expect("正文含成功与失败计数", [line.includes("成功 233"), line.includes("失败 0")], [true, true]);
expect("正文写明成功率分母", line.includes("分母为有返回结果的 233 次"), true);
expect(
  "正文说明无结果的性质与处置",
  line.includes("37 次调用没有结果落库") && line.includes("不计入成功率分子分母"),
  true,
);
expect("没有无结果调用时不提这一句", outcomeLine(MIXED).includes("没有结果落库"), false);
expect("算不出成功率时给「—」而不是 0%", outcomeLine(ALL_UNFINISHED).includes("成功率 —"), true);
expect("算不出成功率时不写成 100%", outcomeLine(ALL_UNFINISHED).includes("100%"), false);

// 6) 真实数据走查：平台统计的三态必须自洽，且确实存在未返回的调用（否则上面几条是空跑）
const s = computePlatformStats();
expect(
  "平台三态互斥且穷尽",
  s.toolOk + s.toolFailed + s.toolUnfinished,
  s.toolCalls,
);
expect("各作品三态之和等于该作品调用总数", s.perAgent.every((a) => a.toolOk + a.toolFailed + a.toolUnfinished === a.toolCalls), true);
expect("各作品成功数之和等于平台成功数", s.perAgent.reduce((n, a) => n + a.toolOk, 0), s.toolOk);
expect("各作品未返回数之和等于平台未返回数", s.perAgent.reduce((n, a) => n + a.toolUnfinished, 0), s.toolUnfinished);
// 分母口径的差异只在「有无结果调用」时才显现，因此用固定样例断言，不依赖库里当下有没有孤儿行
expect(
  "有无结果调用时，成功率必须不同于按调用总数算的旧口径",
  successRate(REAL) !== Math.round((REAL.ok / REAL.calls) * 10000) / 100,
  true,
);
expect("真实数据三态里成功数不超过调用总数", s.toolOk <= s.toolCalls && s.toolOk >= 0, true);

// 7) 配对不变量：每次调用都收到了结束事件时，就不该有结果没落库的行。
// 按工具名配对的那版实测 tool_start / tool_end 各 270 条一一成对，却有 37 行永远停在 ok IS NULL。
const endEvents = (
  db.prepare(`SELECT COUNT(*) n FROM events WHERE kind = 'tool_end'`).get() as { n: number }
).n;
const startEvents = (
  db.prepare(`SELECT COUNT(*) n FROM events WHERE kind = 'tool_start'`).get() as { n: number }
).n;
expect("tool_start 与 tool_end 事件一一成对", startEvents, endEvents);
expect("结束事件数与调用行数一致", endEvents, s.toolCalls);
expect(
  "结束事件齐全时不该有结果没落库的调用行（配对回归就会红）",
  endEvents === s.toolCalls ? s.toolUnfinished : 0,
  0,
);
expect(
  "有结果的行都写了 ok 与 ended_at",
  (
    db
      .prepare(
        `SELECT COUNT(*) n FROM tool_calls WHERE result IS NOT NULL AND result <> '' AND (ok IS NULL OR ended_at IS NULL)`,
      )
      .get() as { n: number }
  ).n,
  0,
);
expect(
  "失败行都带了可读的错误结果（否则「失败 N」点进去什么也看不到）",
  (
    db.prepare(`SELECT COUNT(*) n FROM tool_calls WHERE ok = 0 AND (result IS NULL OR result = '' OR result = 'null')`).get() as {
      n: number;
    }
  ).n,
  0,
);

// 8) 静态走查：两处修复不能被改回去
const here = path.dirname(fileURLToPath(import.meta.url));
const apiSrc = path.resolve(here, "..", "src");
const coreSrc = path.resolve(here, "..", "..", "..", "packages", "agent-core", "src");
const runner = fs.readFileSync(path.join(apiSrc, "services", "agent-runner.ts"), "utf8");
const factory = fs.readFileSync(path.join(coreSrc, "agent-factory.ts"), "utf8");
ok(
  "运行器按 SDK 的 toolCallId 配对开始与结束事件",
  runner.includes("pendingToolCalls.set(event.toolCallId, callId)") &&
    runner.includes("pendingToolCalls.get(event.toolCallId)"),
);
ok("运行器不再按工具名配对（同名工具并发或连续调用会互相覆盖）", !runner.includes("pendingToolCalls.set(event.toolName"));
ok(
  "归一化事件从事件顶层读 isError（ToolExecutionEndEvent.isError），不只读 result.isError",
  factory.includes("e.isError === true"),
);
ok(
  "结果里带非空 error 字符串同样算失败（社区联网工具用 details.error 报失败而不置 isError）",
  factory.includes("detailsError"),
);
ok("归一化事件带上 toolCallId", factory.includes('kind: "tool_end"') && factory.includes("toolCallId: e.toolCallId"));

console.log(
  `[verify] 工具调用三态：总 ${s.toolCalls} · 成功 ${s.toolOk} · 失败 ${s.toolFailed} · 无结果 ${s.toolUnfinished} · 成功率 ${
    successRate({ calls: s.toolCalls, ok: s.toolOk, failed: s.toolFailed, unfinished: s.toolUnfinished })
  }%（按调用总数算的旧口径 ${Math.round((s.toolOk / s.toolCalls) * 1000) / 10}%）`,
);
console.log(`[verify] 三态口径检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 工具调用三态口径不符");
  process.exit(1);
}
console.log("[PASS] 工具调用三态口径正确（分母只取有结果的调用 / 环图三段 / 文字口径 / 配对不变量 / 静态走查）");
