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
import { getTask, listTasks } from "../src/services/task-store.ts";
import { statsFor } from "./materials-lib.ts";
import { LEDGER_COLUMNS } from "../../web/src/evidence-ledger.ts";
import { MAX_RETAINED_TEXT } from "@tax/agent-core";

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

// ---- README：唯一一份手写、不由生成脚本取数的对外文档 ----
// 作品说明由 gen:materials 生成，数字随库变；README 是人写的，写死的数字不会自己更新。
// 实测过期了 6 处：qa:all 写「42 项 verify」而实际 57 项；「24 个任务」而实际 40 个；
// 「rd-audit 18 个 / land-vat 6 个」而实际 29 / 11；「弱证据 23 条待人工处置」而按现行判据
// 待处置是 0 条（15 条已声明背景参考 + 8 条未进结论正文）；「覆盖率 36.84%」而实际 100%
//（那 36.84% 是模板类比对被误记成覆盖缺口时的旧值）；「台账第 16 列「其中复查取得」的高亮」
// 而实际高亮的是第 7 列「待复查」与第 12 列「证据力弱」，「其中复查取得」在第 5 列。
// 判据与作品说明同一套：当前状态数字必须与取数一致，历史数字附近必须有限定词。
const stats = computePlatformStats();
const tasks = listTasks();
const agentTasks = (id: string): [number, number] => {
  const list = tasks.filter((t) => t.agentId === id);
  return [list.length, list.filter((t) => String(getTask(t.id)?.result ?? "").trim() !== "").length];
};
const [rdTotal, rdDone] = agentTasks("rd-audit");
const [lvTotal, lvDone] = agentTasks("land-vat");
// 作品说明的智能体级数字必须与看板出自同一份取数。materials-lib 的 statsFor 此前自己跑了一遍
// SQL 数工具调用三态与产物数——同一件事写两遍，而本文件的比对口径就曾在两边各写一遍并对不上
// （09-28 的旧比对压过 09-29 的最新一次）。合并之后这条断言钉的是「同源」这个事实本身：数字
// 相等今天成立（实测 2 个智能体 × 7 个字段 0 处不一致），将来有人把 SQL 加回来就会红。
const AGENT_FIELDS = [
  "tasks",
  "completed",
  "toolCalls",
  "toolOk",
  "toolFailed",
  "toolUnfinished",
  "artifacts",
] as const;
for (const a of stats.perAgent) {
  const mine = statsFor(a.agentId) as unknown as Record<string, number>;
  const board = a as unknown as Record<string, number>;
  for (const f of AGENT_FIELDS) {
    checks += 1;
    if (mine[f] !== board[f]) {
      failures.push(`${a.agentId} 作品说明取数的 ${f}=${mine[f]} 与看板 perAgent 的 ${f}=${board[f]} 不一致`);
    }
  }
}
expect("确实比到了两个智能体（不是空跑）", stats.perAgent.length >= 2, true);
const libSrc = fs.readFileSync(path.resolve(ROOT, "apps/api/scripts/materials-lib.ts"), "utf8");
expect("materials-lib 不再自己数工具调用三态（那份口径只在看板一处）", libSrc.includes("c.ok === 1"), false);
expect("materials-lib 的智能体级数字取自看板 perAgent", libSrc.includes("computePlatformStats().perAgent.find"), true);
const rootPkg = JSON.parse(fs.readFileSync(path.resolve(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const qaAll = rootPkg.scripts["qa:all"] ?? "";
const qaVerifies = [...new Set(qaAll.match(/pnpm verify:[\w:-]+/g) ?? [])];
const definedVerifies = Object.keys(rootPkg.scripts).filter((k) => k.startsWith("verify:"));
// qa:all 里调到的 verify 与 package.json 里定义的 verify 必须一一对应：
// 少调一个就是新门禁没进全量门（绿得没人知道），多调一个就是脚本名写错（qa:all 当场炸）
expect("qa:all 调用的 verify 数与 package.json 里定义的一致", qaVerifies.length, definedVerifies.length);
for (const k of definedVerifies) {
  checks += 1;
  if (!qaAll.includes(`pnpm ${k}`)) failures.push(`${k} 在 package.json 里定义了，但 qa:all 没调用它`);
}

const ev = stats.evidence;
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
checks += 1;
if (readme.length < 3000) failures.push(`README.md 只有 ${readme.length} 字，像是被截断了`);
// 「真开浏览器」的实测门禁刻意不进 qa:all（要前端在跑、失败原因常与代码无关），所以它们唯一的
// 曝光位置就是 README 的命令清单——此前清单里一个都没提，读的人不知道它们存在，等于这几道门禁
// 没人跑：界面 Markdown 残留、界面数字与取数是否一致、交付物字节是否合规、渲染耗时，全都无人复核。
//
// 判据从 package.json 枚举，不点名：点名清单每加一道 scan 门禁就得回来补一行，而本轮新增
// `perf:render` 时正是这么漏的——README 里写了，却没有任何断言盯着它，下次有人重写那段清单
// 就会静默掉一道门禁，而且掉的正是唯一不在 qa:all 里的那一类（掉了没有任何门禁会红）。
const rootScripts = (
  JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> }
).scripts;
const apiScripts = (
  JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "api", "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  }
).scripts;
const qaAllCmd = rootScripts?.["qa:all"] ?? "";
/** 顺着 root 那条 `pnpm --filter @tax/api <name>` 找到最终跑的脚本文件名 */
const scriptFileOf = (name: string): string => {
  const filtered = /--filter\s+@tax\/api\s+([a-z0-9:-]+)\s*$/.exec(rootScripts?.[name] ?? "")?.[1] ?? name;
  return /scripts\/([\w.-]+\.ts)/.exec(apiScripts?.[filtered] ?? "")?.[1] ?? "";
};
const browserGates = Object.keys(rootScripts ?? {}).filter(
  (n) => !qaAllCmd.includes(`pnpm ${n}`) && scriptFileOf(n).startsWith("scan-"),
);
expect("确实枚举到了要浏览器与前端的门禁（不是 package.json 没读到在这儿空跑）", browserGates.length >= 3, true);
expect(
  "枚举结果确实包含已知的两道（--filter 链解析不出来时会静默少项，那条 >= 3 也就跟着失效）",
  [browserGates.includes("scan:uimd"), browserGates.includes("scan:deliverables")],
  [true, true],
);
expect(
  "每道要浏览器与前端的门禁都在 README 里写清了怎么跑（漏了等于这道门禁没人知道要跑）",
  browserGates.filter((n) => !readme.includes(`pnpm ${n}`)),
  [],
);
expect(
  "README 说清这几道 scan 不进 qa:all（否则会被当成全量门的一部分，以为跑过 qa:all 就跑过了）",
  (readme.match(/不进 qa:all/g) ?? []).length >= 1 && readme.includes("需要先 pnpm dev"),
  true,
);
expect(
  "README 写明 --strict 的退出码语义（供门禁化使用）",
  readme.includes("--strict") && readme.includes("退出码 1"),
  true,
);
console.log(
  `[verify] 要浏览器与前端的门禁 ${browserGates.length} 道（不进 qa:all，只靠 README 曝光），逐个核对命令清单：${browserGates.join("、")}`,
);

// 证据包目录：qa:all 末尾的 pack:evidence 会按当天日期多留一轮，所以「第几轮 / 最后一轮是哪天」
// 是**每跑一次门禁就会变的数**。这种数字不该写进 README——写进去就注定过期，而且过期是门禁自己
// 造成的（实测：本轮把 README 改成「四轮…至 10-01」并跑 qa:all，跑完当场变成五轮…至 10-02，
// 自己把自己的断言搞红了）。判据因此反过来断：README 必须用通配写法，且不得写死轮次或具体日期。
const evidenceDirs = fs
  .readdirSync(path.join(ROOT, "data"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^evidence-\d{4}-\d{2}-\d{2}$/.test(d.name))
  .map((d) => d.name)
  .sort();
/** README 里的当前状态数字：写了就必须与取数一致，且每条都必须真的匹配到（防止改写后静默失去覆盖） */
const README_CURRENT: Array<[string, RegExp, number[]]> = [
  ["qa:all 的 verify 项数", /全量质量门：(\d+) 项 verify/g, [qaVerifies.length]],
  ["案例编号数与任务总数", /(\d+) 个案例编号、(\d+) 个任务/g, [new Set(tasks.map((t) => t.caseId).filter(Boolean)).size, tasks.length]],
  ["rd-audit 任务数与已出结论数", /rd-audit (\d+) 个任务、其中 (\d+) 个已出结论/g, [rdTotal, rdDone]],
  ["land-vat 任务数与已出结论数", /land-vat (\d+) 个任务、其中 (\d+) 个已出结论/g, [lvTotal, lvDone]],
  ["弱证据条数与待处置数", /弱证据引用 (\d+) 条，按现行判据待处置 (\d+) 条/g, [ev.weakCitations, Math.max(0, ev.weakCitations - ev.weakDisclaimed - ev.weakUncited)]],
  ["已声明背景参考的弱证据条数", /其中 (\d+) 条已在结论中写明/g, [ev.weakDisclaimed]],
  ["未进结论正文的弱证据条数", /(\d+) 条只出现在联网检索留存里/g, [ev.weakUncited]],
  [
    "底稿比对累计项数 / 一致 / 填错 / 一致率 / 覆盖率",
    /底稿比对累计 (\d+) 项：一致 (\d+) \+ 填错 (\d+)，一致率 (\d+)% · 覆盖率 (\d+)%/g,
    [stats.compareCompared, stats.compareMatched, stats.compareMismatched, Math.round(stats.compareMatchRateOverall ?? -1), Math.round(stats.compareCoverageOverall ?? -1)],
  ],
  [
    "台账两列欠账的列号",
    /第 (\d+) 列「待复查」、第 (\d+) 列「证据力弱」/g,
    [LEDGER_COLUMNS.indexOf("待复查") + 1, LEDGER_COLUMNS.indexOf("证据力弱") + 1],
  ],
];
expect("确实读到了证据包目录（不是空数组上通过的）", evidenceDirs.length >= 1, true);
checks += 1;
if (!readme.includes("data/evidence-*")) {
  failures.push("README 没有用通配写法 data/evidence-* 引用证据包（写死轮次会在每次 qa:all 之后过期）");
}
checks += 1;
if (/[一二三四五六七八九十\d]+\s*轮证据包/.test(readme)) {
  failures.push("README 里写死了证据包轮次：pack:evidence 每跑一次就多一轮，这个数注定过期");
}
checks += 1;
if (/data\/evidence-\d{4}-\d{2}-\d{2}/.test(readme)) {
  failures.push("README 里写死了某一轮证据包的日期：同上，改用 data/evidence-* 通配");
}
let readmeChecked = 0;
for (const [label, re, want] of README_CURRENT) {
  let matched = 0;
  for (const m of readme.matchAll(re)) {
    matched += 1;
    readmeChecked += 1;
    checks += 1;
    const got = m.slice(1).map(Number);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`README 里写的${label} ${got.join("/")} 与平台当前值 ${want.join("/")} 不一致`);
    }
  }
  // 每条判据都必须真的匹配到文本：README 改写后正则失配的话，这一项会静默变成「没写就不核对」
  checks += 1;
  if (matched < 1) failures.push(`README 里找不到「${label}」的写法，这条核对等于没生效（正则失配？）`);
}
// 历史数字同样要带限定词，否则 36.84% 这种旧值会被读成当前口径
for (const needle of ["36.84%", "matched 均为 0"]) {
  const at = readme.indexOf(needle);
  if (at < 0) continue;
  checks += 1;
  const around = readme.slice(Math.max(0, at - 160), at + 160);
  if (!/(此前|当时|一度|历史|修复当时)/.test(around)) {
    failures.push(`README 里的历史数字「${needle}」附近没有时间或「此前/一度」限定词，会被读成当前口径`);
  }
}
expect("确实核对到了 README 的当前状态数字", readmeChecked >= README_CURRENT.length, true);
console.log(
  `[verify] README 当前状态数字核对 ${readmeChecked} 处（任务 ${tasks.length} 个 · rd-audit ${rdTotal}/${rdDone} · land-vat ${lvTotal}/${lvDone} · 弱证据 ${ev.weakCitations} 条待处置 ${Math.max(0, ev.weakCitations - ev.weakDisclaimed - ev.weakUncited)} · 比对累计 ${stats.compareCompared} 项）`,
);
console.log(
  `[verify] 对外文档 ${docsRead} 份 · 当前状态数字核对 ${stateChecked} 处 · 历史数字限定词核对 ${historyChecked} 处（平台当前：金额 ${e.amountTotal} 处 / 待确认 ${e.amountPending} · 引用 ${e.citations} 条 · 检索 ${e.searchCalls} 次 · 文号 ${e.docRefs} 处）`,
);

// 留存正文的字数上限：常量在 agent-core（MAX_RETAINED_TEXT），作品说明里此前写死「单次 20000 字」。
// 写死的数字改常量时不会跟着变，对外就成了假话；现在改成插值，并断言两边同源。
// 同一句话里「截断量单独记在 omittedChars」也过时了：截断有两层（工具自报 truncated / 平台留存
// 撞上限），两层还曾共用一个字段名互相覆盖，这些都在文档里如实交代。
const rdDoc = fs.readFileSync(path.join(ROOT, "docs", "competition", "智研税审-作品说明.md"), "utf8");
expect("作品说明写出的留存上限取自 agent-core 的常量", rdDoc.includes(`单次 ${MAX_RETAINED_TEXT} 字`), true);
expect("materials-lib 不再写死留存上限", libSrc.includes("单次 20000 字"), false);
expect("materials-lib 引用了 MAX_RETAINED_TEXT", libSrc.includes("MAX_RETAINED_TEXT"), true);
expect(
  "作品说明交代了两层截断（工具层与平台留存层各说各的数）",
  [
    rdDoc.includes("联网扩展自己截断返回内容时在 details 里自报 truncated"),
    rdDoc.includes("平台留存撞上限时把截掉的字数记在 omittedChars"),
  ],
  [true, true],
);
expect("作品说明交代了撞名已在源头分开", rdDoc.includes("toolOmittedChars"), true);
expect(
  "作品说明不承诺工具层的字数（各工具口径不同，只报条数、不推算）",
  rdDoc.includes("只报条数、不推算字数"),
  true,
);

// ---- 测试报告：工具链列与准确率列不许自相矛盾 ----
// 报告第三节每行是一个任务，第 5 列是工具调用链、第 6 列是比对准确率。链里写着
// compare_workpapers 跑过、准确率列却是 `—`（意思是「这个任务没有比对数据」），就是行内
// 自相矛盾。实测 26f91720「底稿比对准确率闭环」正是这样：4 次比对、准确率列 `—`，
// 而 09-29 那份报告里同一格还是「0%（地址模式）」——平台统计的判据收紧成「只认
// mode === 'record'」之后它静默退化成了 `—`，此前没有任何门禁读过这份报告
//（读 test-report 的只有 4 个生成/打包脚本，0 个 verify）。
//
// 这条**只能放在本门禁**：report:test 内部会逐个跑 VERIFY_SCRIPTS（42 个，含 verify:stats）
// 再把 PASS/FAIL 写进报告第二节，放进 verify:stats 就成了循环依赖，读到的是上一次生成的报告
//（实测会让报告写出「存在未通过验证项」的假结论，滞后一轮）。本脚本不在那 42 个里，
// 而 qa:all 的顺序是 report:test → … → verify:materials，读到的正是本次生成的报告。
const reportDir = path.join(ROOT, "docs", "testing");
const reportFiles = fs
  .readdirSync(reportDir)
  .filter((f) => /^test-report-\d{4}-\d{2}-\d{2}\.md$/.test(f))
  .sort();
const latestReport = reportFiles[reportFiles.length - 1] ?? "";
expect("找得到最新那份测试报告（这条走查不能空跑）", latestReport !== "", true);
let reportRows = 0;
let reportDashRows = 0;
for (const ln of fs.readFileSync(path.join(reportDir, latestReport), "utf8").split(/\r?\n/)) {
  if (!ln.startsWith("|") || !ln.includes("compare_workpapers")) continue;
  const cells = ln.split("|").map((c) => c.trim());
  // 只认任务明细表：第 2 列是 agent id，避免误伤别的表格里同样提到这个工具名的行
  if (cells[2] !== "rd-audit" && cells[2] !== "land-vat") continue;
  reportRows += 1;
  if ((cells[6] ?? "") === "—") {
    reportDashRows += 1;
    failures.push(`${latestReport} 「${cells[1]}」工具链列有 compare_workpapers、准确率列却是「—」`);
  }
}
expect("报告里确实走到了带比对的任务行（不是空跑）", reportRows > 0, true);
expect("报告里没有「链上有比对、准确率列却是 —」的行", reportDashRows, 0);
// 结论文案由计数器给出，不写死：变异测试时同一件事曾一边报「无一为「—」」一边列出 2 处失败
console.log(
  `[verify] 测试报告 ${latestReport}：工具链含 compare_workpapers 的任务行 ${reportRows} 行 · 其中准确率列为「—」的 ${reportDashRows} 行`,
);

console.log(`[verify] 交付文档数字一致性检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 对外交付文档里的数字与平台当前口径不一致");
  process.exit(1);
}
console.log("[PASS] 对外交付文档数字一致（当前状态取数 · 历史数字带限定词 · 无残留占位符）");
