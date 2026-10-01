/**
 * 验证脚本：交付 MD「政策文号溯源」节（列结构 / 链接 / 依据档位 / 截断提示 / 真实任务走查）。
 * 运行：pnpm verify:docrefmd
 *
 * 为什么需要它：这一节此前是 TaskWorkbench 里 bundleLines() 的一段闭包，任何单测都碰不到，
 * 新加的「留存正文出处」表因此一条断言都没有——列数对不对、链接能不能点开、依据档位有没有写、
 * 超出上限有没有如实说明，全靠肉眼。搬进 delivery-docref.ts 之后才能喂数据跑断言。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { docRefSection } from "../../web/src/delivery-docref.ts";
import { DOC_REF_TABLE_LIMIT, SOURCE_VIA_TEXT, traceDocRefs } from "../../web/src/policy-trace.ts";
import { summarizeRefChecks } from "../../web/src/ref-check.ts";
import type { RefCheckRecord } from "../../web/src/types.ts";
import { loadTaskDocRefs } from "./docref-lib.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

/** 表格行的单元格数（按竖线切，首尾各多一个空串） */
const cells = (line: string): number => line.split("|").length - 2;
/** 表格行第 5 列（依据档位）的文本。按列位置取，不依赖文案常量，常量被清空时才拦得住 */
const viaCell = (line: string): string => (line.split("|")[5] ?? "").trim();
/** 取某张表的数据行：表头之后跳过分隔行，一直取到不再是表格行为止 */
function tableAfter(lines: string[], header: string): string[] {
  const at = lines.indexOf(header);
  if (at < 0) return [];
  const out: string[] = [];
  for (let i = at + 2; i < lines.length; i++) {
    const l = lines[i];
    if (!l || !l.startsWith("|")) break;
    out.push(l);
  }
  return out;
}

const BODY_HEADER = "| # | 文号 | 结论中的上下文 | 留存正文出处 | 依据 |";
const UNTRACED_HEADER = "| # | 文号 | 结论中的上下文 |";
const RECHECK_HEADER = "| # | 文号 | 复查判定 | 检索词 | 证据 |";

// 1) 三档依据各造一处：结构化字段给地址 / 正文来源行给地址 / 认不出来源行如实留空
const WS_BODY = [
  '## Query: "研发费用加计扣除 2021年第28号"',
  "",
  "公告全文 - 中瑞财税信息网站 注：根据国家税务总局公告2023年第8号，本文第一条失效。",
  "Source: 国家税务总局公告2021年第28号 - 中瑞财税信息网站 (http://www.cntax.cn/list_detail/36801.html)",
].join("\n");
const RESULTS = [
  {
    url: "https://fgk.chinatax.gov.cn/zcfgk/a.html",
    title: "别页标题",
    retainedText: "正文里提到国税发〔2006〕187号，但这份没有来源行",
  },
  { queries: ["研发费用加计扣除"], retainedText: WS_BODY },
  { queries: ["另一检索词"], retainedText: "只提到财税〔2016〕29号，没有来源行" },
];
const CONCLUSION =
  "一、依据国税发〔2006〕187号执行；二、据国家税务总局公告2023年第8号，第一条失效；三、参照财税〔2016〕29号。";
const trace = traceDocRefs(CONCLUSION, RESULTS, ["web_search"]);
expect("确实造出了三处「仅正文提到」", trace.tracedByBody, 3);
const noSummary = summarizeRefChecks([]);
const sec = docRefSection({ refTrace: trace, refSummary: noSummary, refChecks: [] });
expect("节标题是「政策文号溯源」", sec[0], "## 政策文号溯源");
expect("节末尾留一个空行（不和后一节粘在一起）", sec[sec.length - 1], "");
expect("留存正文出处表存在", sec.includes(BODY_HEADER), true);
expect("表头是 5 列", cells(BODY_HEADER), 5);
expect("分隔行也是 5 列", cells(sec[sec.indexOf(BODY_HEADER) + 1] ?? ""), 5);
const rows = tableAfter(sec, BODY_HEADER);
expect("表行数与明细条数一致", rows.length, trace.bodyTracedRefs.length);
for (const row of rows) expect(`每行 5 个单元格：${row.slice(0, 26)}…`, cells(row), 5);
const rowOf = (frag: string): string => rows.find((r) => r.includes(frag)) ?? "";
expect(
  "结构化档给出可点开的链接",
  /\]\(https:\/\/fgk\.chinatax\.gov\.cn\/zcfgk\/a\.html\)/.test(rowOf("187号")),
  true,
);
expect("结构化档的依据列写明档位", rowOf("187号").endsWith(`${SOURCE_VIA_TEXT.structured} |`), true);
expect(
  "正文来源行档归到中瑞财税那一页",
  rowOf("2023年第8号").includes("http://www.cntax.cn/list_detail/36801.html"),
  true,
);
expect("正文来源行档的依据列写明档位", rowOf("2023年第8号").endsWith(`${SOURCE_VIA_TEXT["body-line"]} |`), true);
expect("无地址档如实写原因", rowOf("29号").includes("认不出可归属的来源行"), true);
expect("无地址档不硬凑链接", /\]\(http/.test(rowOf("29号")), false);
expect("无地址档的依据列写明档位", rowOf("29号").endsWith(`${SOURCE_VIA_TEXT[""]} |`), true);
let linkCount = 0;
for (const row of rows) {
  for (const m of row.matchAll(/\]\(([^)]*)\)/g)) {
    const u = m[1] ?? "";
    linkCount += 1;
    expect(`链接是 http(s) 且不含空格：${u.slice(0, 40)}`, /^https?:\/\/\S+$/.test(u), true);
  }
}
expect("确实检查到了链接（不是空跑）", linkCount, 2);
// 依据列必须是**非空**文本：上面几条断言的期望值取自 SOURCE_VIA_TEXT 本身，常量被清空时期望值
// 跟着变空，断言就自证其说了。抽检时真踩到——把 body-line 档改成空串，本脚本 182 项全绿，
// 而交付 MD 的依据列已经空了（只有 verify:policytrace 的「文案非空」拦住）。所以这里按列位置
// 独立断一次，不引用常量。
const vias = new Set(rows.map(viaCell));
expect("依据列没有空值", vias.has(""), false);
expect("确实取到了依据列（三档各占一行）", vias.size, 3);
expect(
  "依据列取值都在档位文案表里",
  [...vias].every((v) => Object.values(SOURCE_VIA_TEXT).includes(v)),
  true,
);
expect(
  "表下给出三档依据的说明（三档文案都非空且都出现在脚注里）",
  sec.some((l) => l.startsWith("- 依据档位：")) &&
    Object.values(SOURCE_VIA_TEXT).every((v) => v !== "" && sec.join("\n").includes(v)),
  true,
);

// 2) 复查表只列文号类：此前用 Object.values(refChecks) 把引用复查也列进了这一节，
//    而上面的计数走的是文号复查汇总，于是「已复查 N 处」与表里实际行数对不上。
const mkCheck = (kind: "docref" | "citation", text: string): RefCheckRecord => ({
  key: `${kind}:${text}`,
  kind,
  text,
  query: `${text} 原文`,
  verdict: "matched",
  note: "",
  evidence: { title: `${text} 原文页`, url: "https://www.gov.cn/x.htm", grade: "official", gradeReason: "", snippet: "" },
  subjectUrl: "",
  attempts: [],
  checkedAt: "2026-10-01T10:00:00.000Z",
});
const mixed = [mkCheck("docref", "财税〔2015〕119号"), mkCheck("citation", "某门户词条")];
const sec2 = docRefSection({
  refTrace: trace,
  refSummary: summarizeRefChecks(mixed.filter((c) => c.kind === "docref")),
  refChecks: mixed,
});
const recheckRows = tableAfter(sec2, RECHECK_HEADER);
expect("复查表只列文号类，引用复查不混进来", recheckRows.length, 1);
expect("复查表里那一条就是文号类", recheckRows[0]?.includes("财税〔2015〕119号"), true);
expect("「已复查 N 处」与表行数一致", sec2.some((l) => l.includes("已复查 1 处")), true);
expect("证据列是可点开的链接", /\]\(https:\/\/www\.gov\.cn\/x\.htm\)/.test(recheckRows[0] ?? ""), true);

// 3) 超出上限不静默截断
const manyBody = Array.from(
  { length: DOC_REF_TABLE_LIMIT + 1 },
  (_, i) => `第${i}段 财税〔20${10 + i}〕${100 + i}号 说明\nSource: 页${i} (https://ex.gov.cn/${i}.html)`,
).join("\n\n");
const manyConclusion = Array.from({ length: DOC_REF_TABLE_LIMIT + 1 }, (_, i) => `财税〔20${10 + i}〕${100 + i}号`).join(
  "、",
);
const manyTrace = traceDocRefs(manyConclusion, [{ queries: ["q"], retainedText: manyBody }], ["web_search"]);
expect("确实造出了超过上限的明细", manyTrace.bodyTracedRefs.length, DOC_REF_TABLE_LIMIT + 1);
const manySec = docRefSection({ refTrace: manyTrace, refSummary: noSummary, refChecks: [] });
expect("留存正文出处表最多列上限条", tableAfter(manySec, BODY_HEADER).length, DOC_REF_TABLE_LIMIT);
expect("超出上限时如实说明还有几处没列", manySec.some((l) => l.includes("另有 1 处仅正文提到的文号未列出")), true);
const untracedConclusion = Array.from(
  { length: DOC_REF_TABLE_LIMIT + 1 },
  (_, i) => `国税发〔20${10 + i}〕${200 + i}号`,
).join("、");
const unTrace = traceDocRefs(untracedConclusion, [{ policies: [] }], []);
expect("确实造出了超过上限的待确认文号", unTrace.untraced.length, DOC_REF_TABLE_LIMIT + 1);
const unSec = docRefSection({ refTrace: unTrace, refSummary: noSummary, refChecks: [] });
expect("待确认表最多列上限条", tableAfter(unSec, UNTRACED_HEADER).length, DOC_REF_TABLE_LIMIT);
expect("待确认表超出上限时如实说明", unSec.some((l) => l.includes("另有 1 处待人工确认的文号未列出")), true);

// 4) 真实任务走查：全库每个有结论的任务都生成一遍这一节
const real = loadTaskDocRefs();
expect("确实读到了真实任务", real.length >= 1, true);
let realRows = 0;
let realLinks = 0;
for (const td of real) {
  const lines = docRefSection({ refTrace: td.res, refSummary: td.refSummary, refChecks: td.refChecks });
  checks += 1;
  if (lines[0] !== "## 政策文号溯源") failures.push(`${td.taskId} 节标题不是「政策文号溯源」`);
  checks += 1;
  if (lines[lines.length - 1] !== "") failures.push(`${td.taskId} 节末尾没有留空行`);
  const bodyRows = tableAfter(lines, BODY_HEADER);
  const want = Math.min(td.res.bodyTracedRefs.length, DOC_REF_TABLE_LIMIT);
  checks += 1;
  if (bodyRows.length !== want) failures.push(`${td.taskId} 留存正文出处表 ${bodyRows.length} 行 ≠ ${want} 行`);
  for (const row of bodyRows) {
    checks += 1;
    if (cells(row) !== 5) failures.push(`${td.taskId} 表行不是 5 个单元格：${row.slice(0, 40)}`);
    checks += 1;
    if (viaCell(row) === "") failures.push(`${td.taskId} 依据列是空的：${row.slice(0, 40)}`);
    for (const m of row.matchAll(/\]\(([^)]*)\)/g)) {
      const u = m[1] ?? "";
      realLinks += 1;
      checks += 1;
      if (!/^https?:\/\/\S+$/.test(u)) failures.push(`${td.taskId} 链接不是 http(s)：${u.slice(0, 60)}`);
    }
  }
  realRows += bodyRows.length;
  // 复查表的行数必须等于文号类复查记录数（引用类不算在这一节里）
  const docCount = td.refChecks.filter((c) => c.kind === "docref").length;
  const rr = tableAfter(lines, RECHECK_HEADER);
  checks += 1;
  if (td.refSummary.total > 0 && rr.length !== docCount) {
    failures.push(`${td.taskId} 复查表 ${rr.length} 行 ≠ 文号类复查 ${docCount} 条`);
  }
}
expect("真实数据里确实生成了留存正文出处表", realRows >= 1, true);
expect("真实数据里确实有可点开的出处链接", realLinks >= 1, true);
console.log(
  `[verify] 真实任务 ${real.length} 个：留存正文出处表合计 ${realRows} 行 · 可点开链接 ${realLinks} 个 · 复查表只列文号类`,
);

// 5) 同源：上限常量只有一份，组件里不再有第二份实现
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]): string => fs.readFileSync(path.resolve(here, ...p), "utf8");
const modSrc = read("..", "..", "web", "src", "delivery-docref.ts");
const benchSrc = read("..", "..", "web", "src", "components", "TaskWorkbench.tsx");
expect("两张表都引用同一个上限常量", modSrc.split("slice(0, DOC_REF_TABLE_LIMIT)").length - 1, 2);
expect("上限没有在模块里被写死成字面量", /\.slice\(0,\s*\d+\)/.test(modSrc), false);
expect("组件里只调用这一节一次（没有第二份实现）", benchSrc.split("docRefSection(").length - 1, 1);
expect("组件里不再自己拼这一节的标题", benchSrc.includes('"## 政策文号溯源"'), false);

console.log(`[verify] 交付 MD 文号溯源节检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 交付 MD「政策文号溯源」节不符");
  process.exit(1);
}
console.log("[PASS] 交付 MD「政策文号溯源」节正确（列结构 / 链接 / 依据档位 / 截断提示 / 真实任务走查）");
