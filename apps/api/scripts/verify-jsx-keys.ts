/**
 * 验证脚本：前端 JSX 列表必须有 key。
 *
 * React 的「Each child in a list should have a unique "key" prop」有两种成因：key 重复，或
 * `.map()` 返回的 JSX 压根没写 key。后者可以静态扫出来，而且扫一遍就能当永久门禁——这类问题
 * 在开发模式下只是一条控制台告警、页面上看不出任何异常，靠人眼永远发现不了。
 *
 * 判据（保守，宁可漏报不误报）：找到每个 `.map(` / `.flatMap(`，用括号配对精确取出这一次调用的
 * 完整范围，若范围内出现 JSX 开标签（`<` 后跟字母）却没有 `key=`，判为缺 key。
 * 纯数据变换的 map（不含 JSX）与把渲染委托给函数的 map（`=> renderItem(x)`，无 JSX 字面量）
 * 都不会被误判。
 *
 * 范围必须靠配对算，不能用固定字符窗口：第一版取「到下一个 .map( 之前、上限 1200 字」，结果把
 * map **之后**的 JSX 也吞了进来——`.map((t) => t.createdAt).sort().pop()` 这种返回字符串的调用
 * 被判成「返回 JSX 却没有 key」，13 个组件里误报 41 处，真问题反而被埋掉。
 *
 * 另外断言几处已知的 key 口径：目录、标签、步骤、核对表行、待办分组这五处的 key 来自自由文本，
 * 必须带下标前缀，否则剥掉 Markdown 记号后两个同名条目会撞 key。
 *
 * 运行：pnpm verify:jsxkeys
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let checks = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, "..", "..", "web", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const files = walk(webSrc).sort();
const MAP_RE = /\.(?:map|flatMap)\s*\(/g;
// JSX 开标签要求 `<` 前一个字符不是标识符字符或点号，否则会把 TypeScript 泛型当成 JSX：
// `const a = c.args as Record<string, unknown> | null;` 里的 `<s` 就命中过 `/<[A-Za-z]/`，
// 让一个只返回字符串的数据 map 被误判成「返回 JSX 却没有 key」。
const JSX_TAG = /(^|[^A-Za-z0-9_$.])<[A-Za-z]/;

/**
 * 返回与 src[open] 处的 "(" 匹配的 ")" 下标；找不到返回 -1。
 * 需要跳过字符串、模板字面量（含 ${} 里的任意嵌套）与注释，否则模板里的 `${agentName(id)}`
 * 那些括号会把配对算歪。正则字面量没有处理——渲染函数体里极少见，出现时最多退化成一次漏报。
 */
function matchParen(src: string, open: number): number {
  const stack: string[] = ["("];
  for (let i = open + 1; i < src.length; i += 1) {
    const ch = src[i]!;
    const top = stack[stack.length - 1];
    if (top === "`") {
      if (ch === "\\") { i += 1; continue; }
      if (ch === "`") { stack.pop(); continue; }
      if (ch === "$" && src[i + 1] === "{") { stack.push("{"); i += 1; }
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) return -1;
      i = nl;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i += 1;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "`") { stack.push("`"); continue; }
    if (ch === "(" || ch === "[" || ch === "{") { stack.push(ch); continue; }
    if (ch === ")" || ch === "]" || ch === "}") {
      const opened = stack.pop();
      if (ch === ")" && opened === "(" && stack.length === 0) return i;
    }
  }
  return -1;
}

type Violation = { file: string; line: number; snippet: string };
const violations: Violation[] = [];
let mapSites = 0;
let jsxMaps = 0;
let unbalanced = 0;

/**
 * 把字符串与模板字面量的**内容**替换成空格（保留 `${}` 里的代码与所有引号本身），
 * 这样 `.map((c, i) => \`| ${i} |<br>${x} |\`)` 这种拼 Markdown 表格文本的调用不会因为
 * 字符串里有个 `<br>` 就被判成「返回 JSX 却没有 key」。第一版没做这一步，3 处命中里有 2 处是
 * 这种误报，真问题（关键词云的 button）反而被淹掉。
 */
function blankLiterals(src: string): string {
  type Frame = { kind: "str"; q: string } | { kind: "tpl" } | { kind: "interp"; depth: number };
  const stack: Frame[] = [];
  const out: string[] = [];
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    const top = stack[stack.length - 1];
    if (top?.kind === "str") {
      if (ch === "\\") { out.push("  "); i += 1; continue; }
      if (ch === top.q) { stack.pop(); out.push(ch); continue; }
      out.push(" ");
      continue;
    }
    if (top?.kind === "tpl") {
      if (ch === "\\") { out.push("  "); i += 1; continue; }
      if (ch === "`") { stack.pop(); out.push(ch); continue; }
      if (ch === "$" && src[i + 1] === "{") {
        stack.push({ kind: "interp", depth: 1 });
        out.push("${");
        i += 1;
        continue;
      }
      out.push(" ");
      continue;
    }
    if (top?.kind === "interp") {
      if (ch === "{") top.depth += 1;
      else if (ch === "}") {
        top.depth -= 1;
        if (top.depth === 0) { stack.pop(); out.push(ch); continue; }
      } else if (ch === '"' || ch === "'") { stack.push({ kind: "str", q: ch }); out.push(ch); continue; }
      else if (ch === "`") { stack.push({ kind: "tpl" }); out.push(ch); continue; }
      out.push(ch);
      continue;
    }
    if (ch === '"' || ch === "'") { stack.push({ kind: "str", q: ch }); out.push(ch); continue; }
    if (ch === "`") { stack.push({ kind: "tpl" }); out.push(ch); continue; }
    out.push(ch);
  }
  return out.join("");
}

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(webSrc, file).replace(/\\/g, "/");
  MAP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MAP_RE.exec(src)) !== null) {
    mapSites += 1;
    const open = m.index + m[0].length - 1; // 指向 "("
    const close = matchParen(src, open);
    if (close < 0) {
      unbalanced += 1;
      continue;
    }
    const slice = src.slice(m.index, close + 1);
    const code = blankLiterals(slice);
    if (!JSX_TAG.test(code)) continue; // 纯数据变换或只拼字符串，不涉及 JSX
    jsxMaps += 1;
    if (/\bkey=/.test(code)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    violations.push({ file: rel, line, snippet: slice.replace(/\s+/g, " ").slice(0, 110) });
  }
}

ok(
  "所有返回 JSX 的 map 都写了 key",
  violations.length === 0,
  violations.slice(0, 10).map((v) => `${v.file}:${v.line} ${v.snippet}`).join(" ｜ "),
);
ok("确实扫到了前端组件", files.length > 10, `${files.length} 个 .tsx`);
ok("确实扫到了返回 JSX 的 map（否则上面那条是空跑）", jsxMaps > 10, `map 调用 ${mapSites} 处，其中含 JSX ${jsxMaps} 处`);
expect("括号配对全部成功（失败说明扫描器有没处理的语法）", unbalanced, 0);

// 自由文本当 key 的几处必须带下标前缀：剥掉 Markdown 记号后两个同名条目会变成同一个字符串
const wb = fs.readFileSync(path.join(webSrc, "components", "TaskWorkbench.tsx"), "utf8");
expect("目录 / 标签 / 步骤 / 核对表行 / 待办分组的 key 都带下标", [
  wb.includes("<li key={`${i}-${h}`}>"),
  wb.includes("key={`${ti}-${t}`}"),
  wb.includes("key={`${i}-${step.label}`}"),
  wb.includes("key={`${n}-${r.item}`}"),
  wb.includes("key={`${gi}-${g.label}`}"),
], [true, true, true, true, true]);

// 结构上保证唯一的 key 不必加下标，但要断言它们确实来自去重后的数据，别哪天悄悄退化
ok("引用胶囊按 URL 去重后再渲染（key={c.url} 才成立）", wb.includes("mergeCitations("));
ok(
  "时间线条目 id 由 seq 与 kind 组成，天然唯一",
  // 聚合口径搬到了 task-events.ts（hook 里只剩订阅与批量刷新），断言跟着搬到同一处，别指向空文件
  fs.readFileSync(path.join(webSrc, "task-events.ts"), "utf8").includes("id: `${event.seq}-${event.kind}`"),
);

console.log(
  `[verify] JSX key 走查：${files.length} 个组件 · map 调用 ${mapSites} 处 · 其中返回 JSX ${jsxMaps} 处 · 缺 key ${violations.length} 处 · 配对失败 ${unbalanced} 处`,
);
console.log(`[verify] JSX key 检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 12)) console.log(`  - ${f}`);
  console.log("[FAIL] JSX 列表 key 口径不符");
  process.exit(1);
}
console.log("[PASS] JSX 列表 key 正确（返回 JSX 的 map 都有 key / 自由文本 key 带下标 / 唯一 key 有去重前提）");
