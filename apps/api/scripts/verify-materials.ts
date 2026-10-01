/**
 * 验证脚本：对外交付文档（作品说明）里的数字必须与平台当前口径一致。
 * 运行：pnpm verify:materials
 *
 * 为什么需要它：作品说明是交出去的材料，里面的数字此前分两种来源——一种是生成时取数
 *（`evidenceSnapshotText` 那一串，随库变），另一种是**手写死在文案里**的（「全平台 612 处
 * 结论金额零待确认」「成功率 97.41%」「引用 169 → 170」）。手写的那批不会随库更新，于是库里
 * 早已是 995 处金额、92 处待人工确认，交付件上仍然印着「零待确认」。这不是取数漏了，是压根
 * 没取数——而五处口径里恰好只有这一处此前完全没有门禁盯着（看板 / 台账 / 交付 MD / manifest
 * 都由 verify:manifest 的交叉核对逐项比过了）。
 *
 * 判据四条：
 * 1. **当前状态数字**必须与 `computePlatformStats` 逐项一致（金额、检索、引用、文号四族）；
 *    按「文档里写了就核对、没写不算失败」的方式匹配，两份作品说明覆盖的范围本来就不同。
 * 2. **历史数字**（描述某次修复当时的效果）允许保留原值，但附近必须有时间或「当时 / 此前 /
 *    修复当时」这类限定词，否则读起来就是当前口径。
 * 3. 生成出来的文档里不得残留未替换的 `{占位符}`——占位符键名写错时会原样留着，这条当场抓到。
 * 4. 与当前数据矛盾的绝对声明（待确认 > 0 时写「零待确认」）直接判失败。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computePlatformStats } from "../src/services/stats.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..", "..");
const DOCS = ["智研税审-作品说明.md", "土增智填-作品说明.md"].map((n) => path.join(ROOT, "docs", "competition", n));

const e = computePlatformStats().evidence;

/** 当前状态数字：文档里写了就必须与平台一致（没写不算失败，两份文档覆盖范围不同） */
const CURRENT: Array<[string, RegExp, number]> = [
  ["结论金额总数", /全平台 (\d+) 处结论金额/g, e.amountTotal],
  ["待确认金额", /(\d+) 处待确认（引自联网正文/g, e.amountPending],
  ["引自联网正文的金额", /引自联网正文 (\d+) 处/g, e.amountPendingWeb],
  ["三处均无出处的金额", /三处均无出处 (\d+) 处/g, e.amountPendingUnexplained],
  ["联网检索次数", /检索 (\d+) 次/g, e.searchCalls],
  ["引用条数", /引用 (\d+) 条/g, e.citations],
  ["官方原文条数", /官方 (\d+) 条/g, e.officialCitations],
  ["政策文号处数", /文号 (\d+) 处/g, e.docRefs],
  ["文号有出处", /有出处 (\d+) 处/g, e.docRefTraced],
];

/** 历史数字：可以保留当时的值，但附近必须有限定词，否则会被读成当前口径 */
const HISTORY: Array<[string, RegExp]> = [
  ["成功 263 · 失败 7", /(修复当时|当时|此前|2026-09-30)/],
  ["成功率 97.41%", /(修复当时|当时|此前|2026-09-30)/],
  ["引用 169 → 170", /(修复当时|当时|此前|2026-09-30)/],
];

let docsRead = 0;
let stateChecked = 0;
let historyChecked = 0;

for (const file of DOCS) {
  const name = path.basename(file);
  checks += 1;
  if (!fs.existsSync(file)) {
    failures.push(`${name} 不存在（gen:materials 没跑？）`);
    continue;
  }
  const text = fs.readFileSync(file, "utf8");
  docsRead += 1;
  checks += 1;
  if (text.length < 2000) failures.push(`${name} 只有 ${text.length} 字，像是没生成完`);

  const leftover = [...new Set([...text.matchAll(/\{[a-zA-Z]\w*\}/g)].map((m) => m[0]))];
  checks += 1;
  if (leftover.length > 0) {
    failures.push(`${name} 里残留未替换的占位符：${leftover.slice(0, 5).join("、")}`);
  }

  for (const [label, re, want] of CURRENT) {
    for (const m of text.matchAll(re)) {
      stateChecked += 1;
      checks += 1;
      const got = Number(m[1]);
      if (got !== want) failures.push(`${name} 里写的${label} ${got} 与平台当前值 ${want} 不一致`);
    }
  }

  for (const [needle, limiter] of HISTORY) {
    const at = text.indexOf(needle);
    if (at < 0) continue;
    historyChecked += 1;
    checks += 1;
    const around = text.slice(Math.max(0, at - 140), at + 140);
    if (!limiter.test(around)) {
      failures.push(`${name} 里的历史数字「${needle}」附近没有时间或「当时/此前」限定词，会被读成当前口径`);
    }
  }

  if (e.amountPending > 0) {
    checks += 1;
    if (/零待确认/.test(text)) {
      failures.push(`${name} 里写着「零待确认」，而平台当前有 ${e.amountPending} 处待人工确认`);
    }
  }
}

expect("确实读到了全部对外交付文档", docsRead, DOCS.length);
expect("确实核对到了当前状态数字（不是文档里一个都没写）", stateChecked >= 6, true);
expect("确实核对到了历史数字的限定词", historyChecked >= 1, true);
console.log(
  `[verify] 对外文档 ${docsRead} 份 · 当前状态数字核对 ${stateChecked} 处 · 历史数字限定词核对 ${historyChecked} 处（平台当前：金额 ${e.amountTotal} 处 / 待确认 ${e.amountPending} · 引用 ${e.citations} 条 · 检索 ${e.searchCalls} 次 · 文号 ${e.docRefs} 处）`,
);

console.log(`[verify] 交付文档数字一致性检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 对外交付文档里的数字与平台当前口径不一致");
  process.exit(1);
}
console.log("[PASS] 对外交付文档数字一致（当前状态取数 · 历史数字带限定词 · 无残留占位符）");
