/**
 * 验证脚本：交付 MD「联网引用」节（分级行 / 弱证据两类括注 / 仅元数据检索 / 引用清单 /
 * 替代来源表 / 链接核验汇总与明细同源 / 空态兜底）。
 * 运行：pnpm verify:delivcite
 *
 * 真实任务走查放在 verify:manifest 里（那边已经把 cites / grades / searches / 两类弱证据 /
 * 引用复查汇总 / 链接核验都组装好了，再抄一份取数就是第三处口径），这里负责纯函数级的形状断言。
 *
 * 为什么需要它：这一节是对外声称数字最密的一节，此前写在 bundleLines() 闭包里，一条断言都没有。
 * 上一轮就在它里面查到真缺陷——链接核验的汇总行按当前引用清单过滤、明细行不过滤，同一份 MD 里
 * 「非可访问 4 条」底下列了 5 行（实测 3 个任务）。搬进模块之后汇总与明细由同一份列表就地算出，
 * 本脚本把这条不变量钉成常驻断言。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { citeSection, CITE_TABLE_HEAD, type CiteSectionInput } from "../../web/src/delivery-cite.ts";
import { gradeCitation, GRADE_TEXT, summarizeGrades } from "../../web/src/citation-grade.ts";
import { linkVerdict, summarizeLinkChecks, VERDICT_TEXT } from "../../web/src/link-check.ts";
import { REF_VERDICT_TEXT, summarizeRefChecks } from "../../web/src/ref-check.ts";
import { evidenceDelta, evidenceSnapshot } from "../../web/src/revision-impact.ts";
import { markdownTableCells } from "../../web/src/md-text.ts";
import type { RefCheckRecord } from "../../web/src/types.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

const cells = (line: string): number => markdownTableCells(line).length;
/** 从分级行里按位置抠出三个数字，不引用 GRADE_TEXT/常量，常量被改空时才拦得住 */
const gradeNums = (line: string): number[] => [...line.matchAll(/(\d+) 条/g)].map((m) => Number(m[1]));

const mk = (url: string, title: string) => {
  const g = gradeCitation(url, title);
  return { title, url, grade: g.grade, gradeReason: g.reason };
};
// 三档各造一条：政府文件页 / 专业机构文章页 / 门户首页
const CITES = [
  mk("https://fgk.chinatax.gov.cn/zcfgk/c100012/c5193854/content.html", "研发费用加计扣除政策"),
  mk("https://www.shui5.cn/article/1a/12345.html", "某税务师事务所解读"),
  mk("https://www.baidu.com/", "百度首页"),
];
const GRADES = summarizeGrades(CITES);
expect("确实造出了三档分级（不是全落在一档里）", [GRADES.official, GRADES.professional, GRADES.weak], [1, 1, 1]);

const mkCheck = (text: string, verdict: RefCheckRecord["verdict"], withEvidence: boolean): RefCheckRecord =>
  ({
    key: `citation:${text}`,
    kind: "citation",
    text,
    query: `${text} 原文`,
    verdict,
    note: "",
    evidence: withEvidence
      ? { title: `${text} 官方原文`, url: "https://www.gov.cn/x.htm", grade: "official", gradeReason: "", snippet: "" }
      : null,
    subjectUrl: withEvidence ? "https://www.baidu.com/" : "",
    attempts: [],
    checkedAt: "2026-10-01T10:00:00.000Z",
  }) as unknown as RefCheckRecord;

const CITE_CHECKS = [mkCheck("https://www.baidu.com/", "matched", true), mkCheck("https://zh.wikipedia.org/wiki/X", "empty", false)];
const CITE_SUM = summarizeRefChecks(CITE_CHECKS);
expect("确实造出了两类复查判定", [CITE_SUM.matched, CITE_SUM.empty], [1, 1]);

// 链接核验：ok / blocked / dead / unreachable 各一行，外加一行陈旧行（调用方应已过滤掉，这里不传）
const LINKS = [
  { url: "https://a.gov.cn/ok", ok: true, status: 200, ms: 12 },
  { url: "https://b.gov.cn/blocked", ok: false, status: 412, ms: 30 },
  { url: "https://c.gov.cn/dead", ok: false, status: 404, ms: 8 },
  { url: "https://d.gov.cn/timeout", ok: false, status: null, ms: 8000, error: "timeout" },
];
const LSUM = summarizeLinkChecks(LINKS);
expect("确实造出了四类核验结果", [LSUM.ok, LSUM.blocked, LSUM.dead, LSUM.unreachable], [1, 1, 1, 1]);

const REV = evidenceDelta(
  evidenceSnapshot("一、依据国税发〔2006〕187号执行。参考 https://www.baidu.com/ 。"),
  evidenceSnapshot(
    "一、依据国税发〔2006〕187号执行，并据国家税务总局公告2021年第28号补充。见 https://fgk.chinatax.gov.cn/zcfgk/a.html 。",
  ),
);

/** 留存正文规模：没截断 / 只有留存层截断 / 只有工具层截断三份，用于验「有截断才写这一行」与行里的数字 */
const RETENTION_OK = {
  retainedCalls: 4,
  truncatedCalls: 0,
  retainedChars: 8000,
  omittedChars: 0,
  maxOmitted: 0,
  toolTruncatedCalls: 0,
  toolTruncatedNoBody: 0,
  toolOmittedChars: 0,
};
const RETENTION_TRUNC = { ...RETENTION_OK, retainedCalls: 6, truncatedCalls: 2, retainedChars: 40000, omittedChars: 25004, maxOmitted: 10610 };
const RETENTION_TOOL = { ...RETENTION_OK, toolTruncatedCalls: 4, toolTruncatedNoBody: 3 };

const base: CiteSectionInput = {
  revImpact: null,
  citations: CITES,
  grades: GRADES,
  weakDisclaimed: 0,
  weakUncited: 0,
  weakOpen: 1,
  searches: { metadataOnly: 2, tools: ["web_search", "fetch_content"] },
  emptyNote: null,
  citeSummary: CITE_SUM,
  citeChecks: CITE_CHECKS,
  linkCheckedAt: "2026-10-01T02:00:00.000Z",
  linkChecks: LINKS,
  retention: RETENTION_OK,
};

// 1) 节的骨架
const sec = citeSection(base);
expect("节标题是「联网引用」", sec[0], "## 联网引用");
expect("标题后留一个空行", sec[1], "");
expect("节末尾留一个空行（不和后一节粘在一起）", sec[sec.length - 1], "");
expect("revImpact 为 null 时不写修订影响那两行", sec.some((l) => l.startsWith("- 本次修订对证据的影响")), false);
expect("给了 revImpact 就写出修订影响与对比口径", [
  citeSection({ ...base, revImpact: REV }).some((l) => l.startsWith("- 本次修订对证据的影响：")),
  citeSection({ ...base, revImpact: REV }).some((l) => l.startsWith("- 对比口径：")),
], [true, true]);

// 2) 证据力分级行：三个数字按位置抠出来与传入的 grades 比
const gradeLine = sec.find((l) => l.startsWith("- 证据力分级：")) ?? "";
expect("分级行存在", gradeLine !== "", true);
expect("分级行三个数字与传入的 grades 一致", gradeNums(gradeLine), [GRADES.official, GRADES.professional, GRADES.weak]);
expect("分级行三档文案都写出来了", Object.values(GRADE_TEXT).every((v) => v !== "" && gradeLine.includes(v)), true);
expect("两类弱证据为 0 时不写括注", [gradeLine.includes("已在结论中声明为背景参考"), gradeLine.includes("未进入结论正文")], [false, false]);
const gradeLine2 = citeSection({ ...base, weakDisclaimed: 3, weakUncited: 2 }).find((l) => l.startsWith("- 证据力分级：")) ?? "";
expect("已声明为背景参考的条数写进括注", gradeLine2.includes("（其中 3 条已在结论中声明为背景参考）"), true);
expect("未进结论正文的条数写进括注", gradeLine2.includes("（2 条只在检索留存里、未进入结论正文）"), true);
expect("括注里的数字不是分级数字被误读", gradeNums(gradeLine2).slice(0, 3), [GRADES.official, GRADES.professional, GRADES.weak]);

// 3) 待处置弱证据的提醒句：weakOpen 决定有没有
const REMIND = "- 证据力弱的引用指向门户首页";
expect("weakOpen > 0 时写出替换提醒", sec.some((l) => l.startsWith(REMIND)), true);
expect("weakOpen = 0 时不写替换提醒（都处置完了不该再催）", citeSection({ ...base, weakOpen: 0 }).some((l) => l.startsWith(REMIND)), false);

// 4) 只留元数据的检索
const metaLine = sec.find((l) => l.startsWith("- 另有 ")) ?? "";
expect("仅元数据检索次数写出来", metaLine.includes("另有 2 次联网检索只留存查询元数据"), true);
expect("涉及的工具名用「 / 」连接", metaLine.includes("（web_search / fetch_content）"), true);
expect("metadataOnly = 0 时整行不写", citeSection({ ...base, searches: { metadataOnly: 0, tools: [] } }).some((l) => l.startsWith("- 另有 ")), false);

// 5) 引用清单：条数与每条的三行结构
const listLines = sec.filter((l) => /^\d+\. /.test(l));
expect("引用清单条数与传入一致", listLines.length, CITES.length);
// 每条引用是**一个含换行的数组元素**（编号+标题 / 地址 / 证据力三行），不是三个数组元素。
// 第一版按「数组里有一行等于地址」断，3 条全红——错的是断言不是实现，改成按元素内分行断。
const parts = listLines.map((l) => l.split("\n"));
expect("每条引用都是三行", parts.every((p) => p.length === 3), true);
expect("第一行是「N. 标题」且编号连续", parts.map((p) => p[0]), CITES.map((c, i) => `${i + 1}. ${c.title}`));
expect("第二行是原样地址（可点开、不改写）", parts.map((p) => (p[1] ?? "").trim()), CITES.map((c) => c.url));
expect(
  "第三行的证据力文案取自 GRADE_TEXT 并附判定理由",
  parts.every(
    (p, i) =>
      (p[2] ?? "").trim().startsWith(`证据力：${GRADE_TEXT[CITES[i]!.grade]}（`) &&
      (p[2] ?? "").includes(CITES[i]!.gradeReason),
  ),
  true,
);
// 上一条的期望值取自 GRADE_TEXT 本身，常量被清空时期望跟着变空、断言就自证其说了，所以独立断一次
expect("三档分级文案都非空", Object.values(GRADE_TEXT).every((v) => v !== ""), true);
expect("确实覆盖了三档（不是三条都落在同一档）", new Set(CITES.map((c) => c.grade)).size, 3);

// 6) 替代来源表
expect("替代来源表头是 4 列", cells(CITE_TABLE_HEAD), 4);
const at = sec.indexOf(CITE_TABLE_HEAD);
expect("替代来源表存在", at >= 0, true);
expect("分隔行也是 4 列", cells(sec[at + 1] ?? ""), 4);
const rows: string[] = [];
for (let i = at + 2; i < sec.length && (sec[i] ?? "").startsWith("|"); i++) rows.push(sec[i]!);
expect("表行数与复查明细条数一致", rows.length, CITE_CHECKS.length);
for (const r of rows) expect(`每行 4 个单元格：${r.slice(0, 24)}…`, cells(r), 4);
expect("判定列文案取自 REF_VERDICT_TEXT", rows.every((r) => Object.values(REF_VERDICT_TEXT).some((v) => r.includes(v))), true);
expect("找到替代来源的那行给出可点开链接", /\]\(https:\/\/www\.gov\.cn\/x\.htm\)/.test(rows[0] ?? ""), true);
expect("没找到的那行如实写破折号、不硬凑链接", (rows[1] ?? "").endsWith("| — |"), true);
expect("被复查的原地址写进表里", (rows[0] ?? "").includes("https://www.baidu.com/"), true);
expect("复查汇总为 0 时整张表不写", citeSection({ ...base, citeSummary: summarizeRefChecks([]), citeChecks: [] }).includes(CITE_TABLE_HEAD), false);
const sumLine = sec.find((l) => l.startsWith("- 弱证据引用替代来源检索：")) ?? "";
expect(
  "替代来源检索汇总四个数字与传入一致",
  [...sumLine.matchAll(/(\d+) 条/g)].map((m) => Number(m[1])),
  [CITE_SUM.total, CITE_SUM.matched, CITE_SUM.candidate, CITE_SUM.empty + CITE_SUM.error],
);

// 7) 链接核验：汇总与明细必须由同一份列表推出来
const linkLine = sec.find((l) => l.startsWith("- 链接核验：")) ?? "";
expect("核验汇总行存在", linkLine !== "", true);
expect(
  "汇总行五个数字与就地汇总一致",
  [
    Number(/可访问 (\d+)\/(\d+)/.exec(linkLine)?.[1]),
    Number(/可访问 (\d+)\/(\d+)/.exec(linkLine)?.[2]),
    Number(/失效 (\d+)/.exec(linkLine)?.[1]),
    Number(/拒绝自动访问 (\d+)/.exec(linkLine)?.[1]),
    Number(/无法核验 (\d+)/.exec(linkLine)?.[1]),
  ],
  [LSUM.ok, LSUM.total, LSUM.dead, LSUM.blocked, LSUM.unreachable],
);
const detail = sec.filter((l) => l.startsWith("  - "));
expect("明细行数 == 汇总里的非可访问条数（上一轮的真缺陷，钉成常驻断言）", detail.length, LSUM.total - LSUM.ok);
expect("明细行只列非 ok 的判定", detail.every((l) => Object.entries(VERDICT_TEXT).filter(([k]) => k !== "ok").some(([, v]) => l.includes(`${v}：`))), true);
expect("明细里的地址都来自传入的核验行", detail.every((l) => LINKS.some((r) => l.includes(r.url))), true);
expect("无法核验的那行写错误原因而不是空括号", detail.some((l) => l.includes("timeout")), true);
expect("linkCheckedAt 为 null 时核验整块不写", [
  citeSection({ ...base, linkCheckedAt: null }).some((l) => l.startsWith("- 链接核验：")),
  citeSection({ ...base, linkCheckedAt: null }).filter((l) => l.startsWith("  - ")).length,
], [false, 0]);

// 8) 一条引用都没有时的兜底
const empty = citeSection({ ...base, citations: [], grades: summarizeGrades([]), citeSummary: summarizeRefChecks([]), citeChecks: [] });
expect("没有引用时用固定兜底文案", empty.includes("（本次任务无联网引用）"), true);
expect("没有引用时不写分级行", empty.some((l) => l.startsWith("- 证据力分级：")), false);
const emptyNote = citeSection({ ...base, citations: [], grades: summarizeGrades([]), emptyNote: "本任务没有联网检索类工具调用", citeSummary: summarizeRefChecks([]), citeChecks: [] });
expect("有检索留痕说明时优先用它", emptyNote.includes("本任务没有联网检索类工具调用"), true);

// 9) 同源：组件里不再有第二份实现
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]): string => fs.readFileSync(path.resolve(here, ...p), "utf8");
const modSrc = read("..", "..", "web", "src", "delivery-cite.ts");
const benchSrc = read("..", "..", "web", "src", "components", "TaskWorkbench.tsx");
expect("组件里只调用这一节一次（没有第二份实现）", benchSrc.split("citeSection(").length - 1, 1);
expect("组件里不再自己拼这一节的标题", benchSrc.includes('"## 联网引用"'), false);
expect("组件里不再自己拼证据力分级行", benchSrc.includes("- 证据力分级："), false);
expect("组件里不再自己拼链接核验行", benchSrc.includes("- 链接核验："), false);
expect("模块里分级文案取自 GRADE_TEXT、没有写死字面量", [modSrc.includes("GRADE_TEXT[c.grade]"), /证据力：官方来源/.test(modSrc)], [true, false]);
// 汇总行里的「拒绝自动访问 N 条」是成句的说明文字，与明细行的判定标签是两回事；这里只断明细行
expect("明细行的判定文案取自 VERDICT_TEXT（不是写死的字面量）", modSrc.includes("VERDICT_TEXT[v]"), true);
expect("模块里汇总就地算、不接受外部传入的汇总", [modSrc.includes("summarizeLinkChecks(linkChecks)"), /summary:\s*LinkSummary/.test(modSrc)], [true, false]);
expect("明细行确实按判定过滤（不是全列）", modSrc.includes('if (v === "ok") continue;'), true);
// 按**调用**判、不按「提到了哪个词」判：模块注释里写了 liveLinkChecks 三个字不算重复实现。
// 这与上一轮 verify:gates 踩过的坑同源——拿文本特征代替结构特征，迟早被自己的注释绊倒。
expect("陈旧行过滤不在本模块重复实现（判据在 link-check.ts）", /liveLinkChecks\s*\(/.test(modSrc), false);

// 8) 留存正文截断说明：两层截断此前零消费者，界面上看不出来、交付 MD 里也没写
const TRUNC_MARK = "本任务的联网留存不完整";
expect("没有截断时整行不写", citeSection(base).some((l) => l.includes(TRUNC_MARK)), false);
const truncLine = citeSection({ ...base, retention: RETENTION_TRUNC }).find((l) => l.includes(TRUNC_MARK)) ?? "";
expect("有截断就写出一行", truncLine !== "", true);
expect("行里给出留存层截断的条数", truncLine.includes("平台留存时又截断 2 条"), true);
expect("行里给出没存下来的字数合计", truncLine.includes("合计 25004 字没有存下"), true);
expect("行里给出单条最多截掉多少", truncLine.includes("单条最多 10610 字"), true);
expect("只有留存层截断时不提工具层", truncLine.includes("联网工具自己截断"), false);
const toolLine = citeSection({ ...base, retention: RETENTION_TOOL }).find((l) => l.includes(TRUNC_MARK)) ?? "";
expect("只有工具层截断时同样写（那一层丢得更多）", toolLine !== "", true);
expect("行里给出工具层截断次数", toolLine.includes("联网工具自己截断了 4 次返回内容"), true);
expect("行里给出连正文都没留住的次数", toolLine.includes("其中 3 次连正文都没能留存"), true);
expect("工具层不编造字数", toolLine.includes("只报条数、不推算字数"), true);
expect(
  "没有引用清单时同样写（截断与有没有引用无关）",
  citeSection({ ...base, citations: [], emptyNote: null, retention: RETENTION_TRUNC }).some((l) =>
    l.includes(TRUNC_MARK),
  ),
  true,
);
expect(
  "写了截断说明时节的末尾仍留一个空行",
  citeSection({ ...base, retention: RETENTION_TRUNC }).at(-1),
  "",
);
expect(
  "文案取自 retentionNote（不在本模块再写一遍）",
  [modSrc.includes("retentionNote(retention)"), new RegExp(TRUNC_MARK).test(modSrc)],
  [true, false],
);
expect("组件里不再自己拼截断说明", benchSrc.includes(TRUNC_MARK), false);

console.log(`[verify] 交付 MD 联网引用节检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 交付 MD「联网引用」节不符");
  process.exit(1);
}
console.log("[PASS] 交付 MD「联网引用」节正确（分级 / 括注 / 清单 / 替代来源表 / 核验汇总与明细同源 / 空态兜底）");
