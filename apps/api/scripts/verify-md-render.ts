/**
 * 验证脚本：渲染前的中文 Markdown 修正（裸地址边界 / ** 紧贴全角标点）。
 *
 * 这两类写法 marked 按 CommonMark 处理不了，会把记号原样吐到界面上：全库 142 个页面实测
 * 扫出 11 处（见 scan-ui-markdown.ts）。这里断言修正后的**性质**——不引入 marked
 *（它是 apps/web 的依赖，apps/api 解析不到），而是钉住「裸地址不再黏着中文」「`**` 不再
 * 紧贴全角标点」「代码块逐字不变」「成对 `**` 数量守恒」这几条，渲染效果由 scan:uimd 实测兜底。
 *
 * 运行：pnpm verify:mdrender
 */
import { EMPH_CJK_RE, fixCjkEmphasis, prepareMarkdown, wrapBareUrls } from "../../web/src/md-render-fix.ts";
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

// 1) 裸地址：后紧跟全角标点与中文时，整段不再被当成链接
expect(
  "裸地址包成尖括号形式，全角右括号不吞进去",
  wrapBareUrls("（中瑞财税信息网站，http://www.cntax.cn/list_detail/36801.html）摘要称该公告失效"),
  "（中瑞财税信息网站，<http://www.cntax.cn/list_detail/36801.html>）摘要称该公告失效",
);
expect(
  "地址尾部的中文标点被剥掉（沿用 cleanBareUrl 口径）",
  wrapBareUrls("见 https://gov.cn/a.pdf。"),
  "见 <https://gov.cn/a.pdf>。",
);
expect("已经是尖括号自动链接的不重复包", wrapBareUrls("<https://gov.cn/a>"), "<https://gov.cn/a>");
expect(
  "markdown 链接目标包成尖括号形式（合法写法），链接文字不动",
  wrapBareUrls("[28号公告](https://gov.cn/a)"),
  "[28号公告](<https://gov.cn/a>)",
);
expect(
  "HTML 属性里的地址不动（前面是引号或等号）",
  wrapBareUrls('<a href="https://gov.cn/a">x</a>'),
  '<a href="https://gov.cn/a">x</a>',
);
expect("查询串里的 & 与 = 保留", wrapBareUrls("https://gov.cn/a?id=1&x=2 后文"), "<https://gov.cn/a?id=1&x=2> 后文");
// 地址后紧跟中文（中间没有标点）时刻意不在中文处硬断：路径里带未转义中文的地址是真实存在的
//（`…/p/研发费用指引.html`，见 cleanBareUrl 的注释），一刀切会把好地址截坏。
// 这类写法仍会整段进链接，但边界由我们定死在下一个空白或闭合符，不会像 gfm 那样一路吃到句号。
expect(
  "地址后紧跟中文时不硬断，但整段由尖括号定界",
  wrapBareUrls("见 https://gov.cn/a.html摘要称 后文"),
  "见 <https://gov.cn/a.html摘要称> 后文",
);

// 2) ** 紧贴全角标点：插入零宽空格造出合法边界，内容一个字都不动。
//    第一版是把标点搬到 ** 外侧，看着等价，实际改小了粗体范围、还让 ** 错位配对，
//    全库扫描的残留从 11 处涨到 253 处。所以这里钉死一条：去掉零宽空格后必须与原文逐字相同。
const ZWSP = "\u200b";
expect(
  "成对 ** 内外两侧都插边界符（全角引号，实测漏渲染的第一类）",
  fixCjkEmphasis("**「归集比对」**工作表"),
  `${ZWSP}**${ZWSP}「归集比对」${ZWSP}**${ZWSP}工作表`,
);
expect(
  "紧贴 ASCII 方括号同样处理（只枚举全角标点时漏掉的第二类）",
  fixCjkEmphasis("**[账账差异]**「直接投入费用」"),
  `${ZWSP}**${ZWSP}[账账差异]${ZWSP}**${ZWSP}「直接投入费用」`,
);
expect(
  "普通粗体也照插：ZWSP 不可见，对本来就能配对的写法没有副作用",
  fixCjkEmphasis("差额 **454,444.45 元**，取决于核查"),
  `差额 ${ZWSP}**${ZWSP}454,444.45 元${ZWSP}**${ZWSP}，取决于核查`,
);
expect(
  "***粗斜体*** 不动（marked 本来就能渲染，插手会把星号拆散）",
  fixCjkEmphasis("***粗斜体*** 与 **粗体**"),
  `***粗斜体*** 与 ${ZWSP}**${ZWSP}粗体${ZWSP}**${ZWSP}`,
);
ok(
  "修正后不再有紧贴内容的 **（两侧都被零宽空格隔开）",
  !fixCjkEmphasis("**「归集比对」**工作表").includes("**「") &&
    !fixCjkEmphasis("**「归集比对」**工作表").includes("」**"),
);
ok("成对 ** 的数量守恒", (fixCjkEmphasis("**「归集比对」**工作表").match(/\*\*/g) ?? []).length === 2);
for (const src of ["**「归集比对」**工作表", "**（含税）**金额", "**“改正”**生成", "差额 **1.00 元**，取决于核查"]) {
  expect(
    `去掉零宽空格后与原文逐字相同：${src.slice(0, 10)}`,
    fixCjkEmphasis(src).replaceAll(ZWSP, ""),
    src,
  );
}

// 3) 代码块里的内容一个字都不动
expect(
  "行内代码里的 ** 与地址不动",
  prepareMarkdown("用 `**bold**` 与 `https://gov.cn/a` 举例"),
  "用 `**bold**` 与 `https://gov.cn/a` 举例",
);
expect(
  "围栏代码块整体不动",
  prepareMarkdown("```bash\ncurl https://gov.cn/a **x**\n```"),
  "```bash\ncurl https://gov.cn/a **x**\n```",
);
expect("mermaid 占位 div 不受影响", prepareMarkdown('<div data-mermaid="0"></div>'), '<div data-mermaid="0"></div>');
expect("空输入安全", prepareMarkdown(""), "");
expect(
  "两类问题在同一段里一起修",
  prepareMarkdown("见 http://gov.cn/a.html）摘要，**「原文」**为准"),
  `见 <http://gov.cn/a.html>）摘要，${ZWSP}**${ZWSP}「原文」${ZWSP}**${ZWSP}为准`,
);

// 4) 真实结论走查：库里每份结论修正后都不能再留下这两类写法
const tasks = db.prepare(`SELECT id, title, result FROM tasks`).all() as unknown as Array<{
  id: string;
  title: string;
  result: string | null;
}>;
// 走查判据只认「地址后面黏着全角标点」：地址里带未转义中文是合法写法（…/p/研发费用指引.html），
// 把汉字也算进去会把好地址判成残留。修正后地址被 <> 定界，`>` 不在字符类里，命中即为真残留。
const BARE_URL_CJK = /https?:\/\/[^\s<>"'`)\]}]*[\u3000-\u303F\uFF00-\uFFEF]/;
let withConclusion = 0;
let urlFixed = 0;
let emphFixed = 0;
const leaks: string[] = [];
for (const t of tasks) {
  const md = String(t.result ?? "");
  if (!md.trim()) continue;
  withConclusion += 1;
  const out = prepareMarkdown(md);
  if (BARE_URL_CJK.test(md.replace(/```[\s\S]*?```/g, " ")) && !BARE_URL_CJK.test(out.replace(/```[\s\S]*?```/g, " "))) {
    urlFixed += 1;
  }
  if (EMPH_CJK_RE.test(md) && !EMPH_CJK_RE.test(out)) emphFixed += 1;
  // 修正后仍存在的：代码块内的不算（本来就刻意不动）
  const noFence = out.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  if (BARE_URL_CJK.test(noFence)) {
    leaks.push(
      `${t.id.slice(0, 8)} 裸地址仍黏着全角标点：${(noFence.match(BARE_URL_CJK) ?? [""])[0].slice(0, 60)}`,
    );
  }
  if (EMPH_CJK_RE.test(noFence)) {
    leaks.push(`${t.id.slice(0, 8)} ** 仍紧贴全角标点：${(noFence.match(EMPH_CJK_RE) ?? [""])[0]}`);
  }
  // 只插边界符、不改内容：这两条是防止再出现「把标点搬出 **」那类改内容的修法
  if (fixCjkEmphasis(md).replaceAll(ZWSP, "") !== md) {
    leaks.push(`${t.id.slice(0, 8)} 强调修正改动了原文字符`);
  }
  if (wrapBareUrls(md).replace(/[<>]/g, "") !== md.replace(/[<>]/g, "")) {
    leaks.push(`${t.id.slice(0, 8)} 地址包裹吞掉了正文`);
  }
  // 成对 ** 总数不因修正而改变（只插边界符）
  const before = (md.match(/\*\*/g) ?? []).length;
  const after = (out.match(/\*\*/g) ?? []).length;
  if (before !== after) leaks.push(`${t.id.slice(0, 8)} ** 数量变了 ${before} → ${after}`);
}
ok("真实结论走查：修正后不再有这两类写法", leaks.length === 0, leaks.slice(0, 5).join("；"));
ok("确实走查到了真实结论", withConclusion > 0, `有结论的任务 ${withConclusion} 个`);
ok("确实修到了裸地址黏中文的结论", urlFixed > 0, `修了 ${urlFixed} 份`);
ok("确实修到了 ** 紧贴全角标点的结论", emphFixed > 0, `修了 ${emphFixed} 份`);

// 5) 静态走查：渲染入口必须接上 prepareMarkdown，否则这些修正根本不会生效
const here = path.dirname(fileURLToPath(import.meta.url));
const mv = fs.readFileSync(path.resolve(here, "..", "..", "web", "src", "components", "MarkdownView.tsx"), "utf8");
ok("MarkdownView 引入 md-render-fix", mv.includes('from "../md-render-fix.ts"'));
ok("marked.parse 之前先做中文修正", mv.includes("marked.parse(prepareMarkdown(prepared)"));
console.log(
  `[verify] 渲染前修正：真实结论 ${withConclusion} 份 · 裸地址黏中文修了 ${urlFixed} 份 · 强调记号修了 ${emphFixed} 份 · 残留 ${leaks.length} 处`,
);
console.log(`[verify] 渲染修正检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 渲染前修正口径不符");
  process.exit(1);
}
console.log("[PASS] 渲染前修正正确（裸地址边界 / 强调记号 / 代码块保护 / 真实结论走查）");
