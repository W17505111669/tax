/**
 * 验证脚本：Markdown 片段转可读纯文本（目录 / 摘要 / 差异行 / 关键词段落共用）。
 *
 * 结论正文由 MarkdownView 渲染成 HTML，但界面上还有一批「一句话展示位」是把结论原文当字符串直接
 * 塞进 JSX 的。不处理就会把 ###、反引号、** 与表格竖线原样显示出来——实测目录里出现过
 * 「1.2 加计扣除测算（`calculate_rd_adjustment`，单次调用 `alternative` 两口径对照…）」，
 * 上次结论预览更是整段 `## 一、事实（工具返回） ### 1.1 …` 原文。
 *
 * 最后一组断言拿库里全部真实结论走查，确保这些展示位不会再出现 Markdown 记号。
 *
 * 运行：pnpm verify:mdtext
 */
import {
  countTables,
  markdownToPlainText,
  plainLine,
  plainContext,
  plainSnippet,
  stripInlineMarkdown,
  tocEntries,
  markdownTableCells,
} from "../../web/src/md-text.ts";
import { db } from "../src/db.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let checks = 0;
const failures: string[] = [];

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

// 1) 行内记号
expect("去反引号", stripInlineMarkdown("调用 `check_rd_expenses` 核查"), "调用 check_rd_expenses 核查");
expect("去粗体", stripInlineMarkdown("**未超限**，可全额加计"), "未超限，可全额加计");
expect("去斜体", stripInlineMarkdown("这是 *重点* 内容"), "这是 重点 内容");
expect("去删除线", stripInlineMarkdown("~~已废止~~ 现行有效"), "已废止 现行有效");
expect("链接留文字", stripInlineMarkdown("见 [国家税务总局公告2021年第28号](http://x.gov.cn/a)"), "见 国家税务总局公告2021年第28号");
expect("图片留替代文字", stripInlineMarkdown("![差异构成图](img.png)"), "差异构成图");
expect(
  "工具名里的单个下划线不动（check_rd_expenses 不是斜体）",
  stripInlineMarkdown("用 check_rd_expenses 与 calculate_rd_adjustment 核查"),
  "用 check_rd_expenses 与 calculate_rd_adjustment 核查",
);
expect("落单的粗体记号也清掉", stripInlineMarkdown("差额 **454,444.45 元**，取决于核查结果").includes("**"), false);

// 2) 单行
expect("标题去井号", plainLine("### 1.2 加计扣除测算（`calculate_rd_adjustment`）"), "1.2 加计扣除测算（calculate_rd_adjustment）");
expect("一级到六级标题都认", [plainLine("# 一"), plainLine("###### 六")], ["一", "六"]);
expect("引用去符号", plainLine("> 比例来源：search_rd_policy"), "比例来源：search_rd_policy");
expect("无序列表去记号", plainLine("- 前五类合计 1,580,000.00 元"), "前五类合计 1,580,000.00 元");
expect("有序列表去记号", plainLine("3. 就 10,000.00 元差异抽取明细核对"), "就 10,000.00 元差异抽取明细核对");
expect("表格分隔行整行清空", plainLine("|---|---:|---|"), "");
expect("表格行竖线换成中点", plainLine("| 前五类费用合计 | 1,580,000.00 | 2,040,000.00 |"), "前五类费用合计 · 1,580,000.00 · 2,040,000.00");
expect("空行安全", plainLine(""), "");

// 3) 整篇
const DOC = [
  "## 一、事实（工具返回）",
  "",
  "### 1.1 归集比对（`check_rd_expenses`）",
  "",
  "| 费用类别 | 金额 |",
  "|---|---|",
  "| 人员人工 | 860,000.00 |",
  "",
  "```mermaid",
  "flowchart TD",
  "  A[辅助账] --> B[限额]",
  "```",
  "",
  "按工具确定性测算，可加计扣除基数 **1,755,555.55 元**。",
].join("\n");
const plain = markdownToPlainText(DOC);
ok("整篇里不再出现井号标题", !/(^|\s)#{1,6}\s/.test(plain), plain.slice(0, 80));
ok("整篇里不再出现反引号", !plain.includes("`"));
ok("整篇里不再出现粗体记号", !plain.includes("**"));
ok("mermaid 围栏内容被整块丢掉（flowchart 不该出现在摘要里）", !plain.includes("flowchart") && !plain.includes("A[辅助账]"));
ok("表格分隔行被丢掉", !plain.includes("---"));
ok("正文文字保留", plain.includes("按工具确定性测算，可加计扣除基数 1,755,555.55 元。"));
ok("表格内容以中点分隔保留", plain.includes("人员人工 · 860,000.00"));

// 4) 摘要截断
expect("空输入给空串，不填占位文字", plainSnippet("", 100), "");
expect("只有围栏代码时也给空串", plainSnippet("```mermaid\nflowchart TD\n```", 100), "");
expect("短文本不加省略号", plainSnippet("前五类合计 1,580,000.00 元", 100), "前五类合计 1,580,000.00 元");
expect("长文本按上限截断并加省略号", plainSnippet("研发费用加计扣除测算".repeat(20), 12), "研发费用加计扣除测算研发…");
expect("截断上限按字符数不按字节数", plainSnippet("研发费用加计扣除测算", 10), "研发费用加计扣除测算");

// 5) 目录条目：只取 h2/h3、按出现顺序、条数受限、与 sec-N 锚点同序
expect("只取二三级标题，一级与四级不进目录", tocEntries("# 封面\n## 一、事实\n### 1.1 比对\n#### 细节"), ["一、事实", "1.1 比对"]);
expect("目录条目已去记号", tocEntries("### 1.2 加计扣除测算（`calculate_rd_adjustment`）"), ["1.2 加计扣除测算（calculate_rd_adjustment）"]);
expect("条数受限", tocEntries(Array.from({ length: 40 }, (_, i) => `## 第 ${i} 节`).join("\n")).length, 24);
expect("limit 可指定", tocEntries(Array.from({ length: 10 }, (_, i) => `## 第 ${i} 节`).join("\n"), "23", 3).length, 3);
expect("空结论给空目录", tocEntries(""), []);

// 6) 真实数据走查：库里每个任务的结论，转出来的目录与摘要都不能再带 Markdown 记号
const tasks = db.prepare(`SELECT id, title, result FROM tasks`).all() as unknown as Array<{
  id: string;
  title: string;
  result: string | null;
}>;
const ARTIFACTS = [
  ["井号标题", /(^|\s)#{1,6}\s/],
  ["反引号", /`/],
  ["粗体记号", /\*\*/],
  ["表格分隔行", /\|\s*-{3,}/],
  ["链接语法", /\]\(https?:\/\//],
] as Array<[string, RegExp]>;
let withConclusion = 0;
let tocTotal = 0;
const leaks: string[] = [];
for (const t of tasks) {
  const md = String(t.result ?? "");
  if (!md.trim()) continue;
  withConclusion += 1;
  const entries = tocEntries(md);
  tocTotal += entries.length;
  const snippet = plainSnippet(md, 200);
  for (const [name, re] of ARTIFACTS) {
    for (const [where, text] of [
      ["目录", entries.join(" | ")],
      ["摘要", snippet],
    ] as Array<[string, string]>) {
      if (re.test(text)) leaks.push(`${t.id.slice(0, 8)} ${where} 残留${name}：${text.slice(0, 60)}`);
    }
  }
}
ok("真实结论走查：目录与摘要里没有 Markdown 记号残留", leaks.length === 0, leaks.slice(0, 5).join("；"));
ok("确实走查到了真实结论", withConclusion > 0, `有结论的任务 ${withConclusion} 个`);
ok("确实提取到了目录条目", tocTotal > 0, `合计 ${tocTotal} 条`);

// 7) 表格计数：分隔行可能带对齐冒号，旧正则 /^\| ?---/ 一张也数不到
expect("常规分隔行", countTables("| a | b |\n|---|---|\n| 1 | 2 |"), 1);
expect("带对齐冒号的分隔行也要数到", countTables("| 项目 | 金额 |\n|:---|---:|\n| 合计 | 1.00 |"), 1);
expect("省略首尾竖线的写法", countTables("a | b\n--- | ---\n1 | 2"), 1);
expect("短横不足三个的居中写法也算分隔行", countTables("|a|b|\n|:--:|--:|\n|1|2|"), 1);
expect("单独的分隔线不算表格", countTables("上文\n\n---\n\n下文"), 0);
expect("数据行不会被误判成分隔行", countTables("| 项目 | 金额 |\n|:---|---:|\n| 人员人工 | 860,000.00 |"), 1);
expect("多张表分别计数", countTables("|a|\n|---|\n|1|\n\n|b|\n|:--:|\n|2|"), 2);
expect("空输入给 0", countTables(""), 0);
const oldTables = tasks.reduce((n, t) => n + (String(t.result ?? "").match(/^\| ?---/gm) ?? []).length, 0);
const newTables = tasks.reduce((n, t) => n + countTables(String(t.result ?? "")), 0);
ok("确实数到了真实结论里的表格", newTables > 0, `合计 ${newTables} 张`);
ok("新口径不少于旧口径（只会多认出带对齐冒号的表，不会少认）", newTables >= oldTables, `旧 ${oldTables} / 新 ${newTables}`);

// 8) 静态走查：展示位必须走 md-text，不能再把结论原文直接塞进 JSX
const here = path.dirname(fileURLToPath(import.meta.url));
const wb = fs.readFileSync(
  path.resolve(here, "..", "..", "web", "src", "components", "TaskWorkbench.tsx"),
  "utf8",
);
ok("结果页引入 md-text 的纯文本化函数", wb.includes('from "../md-text.ts"'));
ok("目录走 tocEntries（不再自己 match 井号）", wb.includes("tocEntries(finalResult)") && !wb.includes('.match(/^#{2,3} .+$/gm)'));
ok("上次结论预览走 plainSnippet", wb.includes("plainSnippet(prevConclusion, 120)"));
ok("摘要首段走 plainSnippet", wb.includes("plainSnippet(firstPara, 220)"));
ok("关键词段落先转纯文本再匹配", wb.includes("markdownToPlainText(s)"));
ok("表格计数走 countTables（旧正则会漏掉带对齐冒号的分隔行）", wb.includes("countTables(finalResult)") && !wb.includes('/^\\| ?---/gm'));
// 目录与几处自由文本列表的 key 都带下标：剥掉 Markdown 记号后两个同名条目会变成同一个字符串
ok("目录 key 带下标，避免剥离记号后同名小节撞 key", wb.includes('<li key={`${i}-${h}`}>'));
expect("自由文本列表的 key 一律带下标（标签 / 步骤 / 核对项 / 待办分组）", [
  wb.includes("key={`${ti}-${t}`}"),
  wb.includes("key={`${i}-${step.label}`}"),
  wb.includes("key={`${n}-${r.item}`}"),
  wb.includes("key={`${gi}-${g.label}`}"),
], [true, true, true, true]);
// 任务指令面板是**有意**保留原文的：那是用户提交的输入逐字回显，与对话流里的用户气泡同一口径。
// 把它也转成富文本反而篡改了「当时提交的是什么」，所以这里断言它保持原样，防止被顺手「修」掉。
ok("任务指令面板保持输入原文回显（有意不渲染）", wb.includes("{task.instruction}"));
// 9) 原文切片（金额与文号的上下文）：跨行压成一行后，行中间的记号也要清掉。
//    plainLine 只处理行首，够不着这种片段——实测复核页的待确认清单里出现过
//    「…其他相关费用为8万元。** > > **（一）按照97号公告…」，粗体与引用记号一起显示了出来。
expect(
  "粗体与连写的引用记号都清掉",
  plainContext("其他相关费用为8万元。** > > **（一）按照97号公告"),
  "其他相关费用为8万元。（一）按照97号公告",
);
expect("行首井号清掉", plainContext("### 1.2 限额为 100,000.00 元"), "1.2 限额为 100,000.00 元");
expect(
  "行内代码的反引号清掉，工具名保留",
  plainContext("调用 `calculate_rd_adjustment` 得出 100,000.00 元"),
  "调用 calculate_rd_adjustment 得出 100,000.00 元",
);
expect("换行与多余空白压成单个空格", plainContext("限额\n  为 100,000.00  元 "), "限额 为 100,000.00 元");
expect("空输入给空串", plainContext(""), "");
expect(
  "无空格的数学比较不动（增值率>50% 不是引用记号）",
  plainContext("增值率>50% 时适用 40% 税率，应纳税额 100,000.00 元"),
  "增值率>50% 时适用 40% 税率，应纳税额 100,000.00 元",
);
expect(
  "链接留文字（上下文里带引用来源时也读得通）",
  plainContext("见 [28号公告](https://gov.cn/a) 第 100,000.00 元"),
  "见 28号公告 第 100,000.00 元",
);
// 上游两处切片（金额溯源 / 文号溯源）都必须走这个函数，否则记号又会漏到界面上
const at = fs.readFileSync(path.resolve(here, "..", "..", "web", "src", "amount-trace.ts"), "utf8");
const pt = fs.readFileSync(path.resolve(here, "..", "..", "web", "src", "policy-trace.ts"), "utf8");
ok("金额溯源的上下文走 plainContext", at.includes('import { plainContext } from "./md-text.ts"') && at.includes("context: plainContext("));
ok("文号溯源的上下文走 plainContext", pt.includes('import { plainContext } from "./md-text.ts"') && pt.includes("const ctx = plainContext("));

// 表格行的单元格拆分：转义的 `\|` 是字面竖线，不能当成列分隔符。用 split("|") 数单元格会把
// 「上下文里带竖线的那一行」多算一列，门禁就会误报表格串列——这是提示词回归新建的任务撞出来的
// 真实形状：模型在结论里如实抄了原文的表格片段，文号上下文以 `\|` 开头。
expect("普通表格行按竖线拆成单元格", markdownTableCells("| a | b | c |"), [" a ", " b ", " c "]);
expect("转义竖线不算列分隔符", markdownTableCells("| a | b\\|c | d |").length, 3);
expect("转义竖线还原成字面竖线", markdownTableCells("| a\\|b | c |")[0]?.trim(), "a|b");
expect("上下文以转义竖线开头也不多算一列", markdownTableCells("| 1 | 文号 | \\| 已失效 | 依据 | 档 |").length, 5);
expect("首尾没有竖线也认", markdownTableCells("a | b"), ["a ", " b"]);
expect(
  "分隔行与表头列数一致",
  markdownTableCells("| --- | --- | --- |").length,
  markdownTableCells("| a | b | c |").length,
);
expect("空行安全兜底", markdownTableCells(""), [""]);
console.log(`[verify] Markdown 纯文本化：真实任务 ${withConclusion} 个 · 目录条目 ${tocTotal} 条 · 残留 ${leaks.length} 处`);
console.log(`[verify] 真实结论表格计数：旧口径 ${oldTables} 张 → 新口径 ${newTables} 张`);
console.log(`[verify] 纯文本化检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] Markdown 纯文本化口径不符");
  process.exit(1);
}
console.log("[PASS] Markdown 纯文本化正确（行内记号 / 单行 / 整篇 / 截断 / 目录 / 表格计数 / 真实结论走查）");
