/**
 * 把 Markdown 片段转成**可读纯文本**，供目录、摘要、差异行、关键词段落这些「一句话展示位」使用。
 *
 * 结论正文由 MarkdownView 渲染成 HTML，那是正路；但界面上还有一批小地方是把结论原文当字符串直接
 * 塞进 JSX 的——目录条目、上次运行结论预览、结论差异行、关键词命中的段落。这些地方不做处理就会
 * 把 `###`、反引号、`**`、表格竖线原样显示出来，实测目录里出现过
 * 「1.2 加计扣除测算（`calculate_rd_adjustment`，单次调用 `alternative` 两口径对照…）」这样的条目，
 * 上次结论预览更是整段 `## 一、事实（工具返回） ### 1.1 …` 的原文。
 *
 * 这里只做「去掉记号、保留文字」，不做渲染：这些位置要的是一行能扫读的文字，不是富文本。
 */

/** 行内记号：代码反引号、粗体、斜体、删除线、链接与图片 */
export function stripInlineMarkdown(text: string): string {
  let s = String(text ?? "");
  // 图片先于链接处理：![alt](url) 留 alt，[text](url) 留 text
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // 成对记号整体去掉。**粗体** / __粗体__ / *斜体* / ~~删除~~
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/\*([^*\n]+)\*/g, "$1");
  s = s.replace(/~~([^~]+)~~/g, "$1");
  // 单反引号与多反引号行内代码
  s = s.replace(/`+([^`]*)`+/g, "$1");
  // 落单的强调记号（如「**未超限**。」被句号截断后剩下的 **）
  s = s.replace(/\*\*(?=\s|$)/g, "").replace(/(?<=\s|^)\*\*/g, "");
  // 单个下划线不去：check_rd_expenses 这类工具名里的下划线是名字的一部分
  return s;
}

/** 一行 Markdown 转纯文本：去掉标题井号、引用符、列表记号与表格竖线，再去行内记号 */
export function plainLine(line: string): string {
  let s = String(line ?? "");
  s = s.replace(/^\s{0,3}#{1,6}\s*/, ""); // 标题
  s = s.replace(/^\s{0,3}>\s?/, ""); // 引用
  s = s.replace(/^\s*([-*+]|\d+[.)])\s+/, ""); // 无序/有序列表记号
  // 表格分隔行（|---|---|）整行没有信息，直接清空
  if (/^\s*\|?[\s:|-]+\|?\s*$/.test(s) && s.includes("-")) return "";
  s = s.replace(/^\s*\|/, "").replace(/\|\s*$/, ""); // 首尾竖线
  s = s.replace(/\s*\|\s*/g, " · "); // 单元格分隔改成可读的中点
  s = stripInlineMarkdown(s);
  return s.replace(/\s+/g, " ").trim();
}

/**
 * 整篇 Markdown 转可读纯文本：丢掉围栏代码块（mermaid 源码与 JSON 不是给人扫读的散文）、
 * 丢掉表格分隔行，其余逐行转纯文本后拼成一段。
 */
export function markdownToPlainText(md: string): string {
  const src = String(md ?? "");
  // 去围栏代码块（``` 或 ~~~），含 mermaid
  const noFence = src.replace(/^\s*(```|~~~)[\s\S]*?^\s*(```|~~~)\s*$/gm, " ");
  return noFence
    .split("\n")
    .map((l) => plainLine(l))
    .filter((l) => l !== "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 取一段可读摘要：先转纯文本，再按长度截断加省略号；空输入返回空串，不填占位文字 */
export function plainSnippet(md: string, max = 160): string {
  const text = markdownToPlainText(md);
  if (!text) return "";
  const limit = Math.max(1, Math.trunc(max));
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 从结论里提取目录条目：取二到四级标题，去记号后作为可点击的章节名。
 * 与 TaskWorkbench 里 `headingIds` 的编号顺序保持一致（同样按出现顺序、同样只取 #{2,3}）。
 */
export function tocEntries(md: string, levels = "23", limit = 24): string[] {
  const src = String(md ?? "");
  // levels 是一串允许的标题级别数字（默认 "23" 即 h2 与 h3），转成 #{lo,hi} 的量词。
  // 早先写成 `#{[${levels}]}`，那是「一个 # 后跟 2 或 3」，永远匹配不到 "## "，目录恒为空。
  const nums = [...String(levels)].map((c) => Number(c)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 6);
  if (nums.length === 0) return [];
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const re = new RegExp(`^\\s{0,3}#{${lo},${hi}}\\s+.+$`, "gm");
  const out: string[] = [];
  for (const m of src.match(re) ?? []) {
    const text = plainLine(m);
    if (text) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 数结论里有几张 Markdown 表格（按分隔行计数）。
 *
 * 早先用的正则是 `/^\| ?---/`，只认「竖线 + 可选空格 + 三个短横」开头的写法，遇到带对齐冒号的
 * `|:---|---:|` 就一张也数不到——实测某个土增任务页面上渲染出 5 张表，摘要里却写「表格 0」。
 *
 * 判据改为逐格检查：整行只由竖线、冒号、短横与空白组成，且去掉首尾竖线后每一格都形如 `:?-+:?`。
 * 短横个数不写死为 3——`|:--:|` 这种居中写法同样是合法分隔行。单独的 `---` 是分隔线不是表格，
 * 靠「必须含竖线」排除。
 */
export function countTables(md: string): number {
  return String(md ?? "")
    .split("\n")
    .filter((line) => {
      const s = line.trim();
      if (!s.includes("|") || !s.includes("-")) return false;
      if (!/^[\s:|-]+$/.test(s)) return false;
      const cells = s.replace(/^\|/, "").replace(/\|$/, "").split("|");
      return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
    }).length;
}
