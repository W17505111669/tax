/**
 * 验证脚本：阅读器查找口径（命中区间 / 计数 / 高亮分段保真 / 环形序号 / 计数文案 /
 * 与旧计数口径在纯文本上一致 / 组件不再各写一份的静态走查）。
 * 运行：pnpm verify:textfind
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  countMatches,
  findRanges,
  matchLabel,
  splitForHighlight,
  stepIndex,
  wrapIndex,
} from "../../web/src/text-find.ts";

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

// 1) 命中区间
expect("两处命中", findRanges("abc abc", "abc"), [
  { start: 0, end: 3 },
  { start: 4, end: 7 },
]);
expect("大小写不敏感", findRanges("AbC x abc", "ABC").length, 2);
expect("命中保留原文大小写", "AbC x abc".slice(0, 3), "AbC");
expect("重叠只算一次（aaaa 里找 aaa）", findRanges("aaaa", "aaa"), [{ start: 0, end: 3 }]);
expect("紧邻的两次都算", findRanges("abab", "ab"), [
  { start: 0, end: 2 },
  { start: 2, end: 4 },
]);
expect("空查询没有命中", findRanges("abc", ""), []);
expect("纯空格查询没有命中", findRanges("abc", "   "), []);
expect("空文本没有命中", findRanges("", "a"), []);
expect("查询比文本长没有命中", findRanges("ab", "abc"), []);
expect("查询前后空格被 trim", findRanges("x 金额 y", "  金额  "), [{ start: 2, end: 4 }]);
expect("中文多处命中", countMatches("人员人工 300000 元，直接投入 100000 元", "元"), 2);
expect("点号当普通字符", findRanges("a.b", "."), [{ start: 1, end: 2 }]);
expect("括号当普通字符", findRanges("(x)", "("), [{ start: 0, end: 1 }]);
expect("反斜杠当普通字符", countMatches("a\\b\\c", "\\"), 2);
const sample = "金额 与 金额 核对；金额一致";
ok(
  "每个区间切出来都等于查询词",
  findRanges(sample, "金额").every((r) => sample.slice(r.start, r.end) === "金额"),
);
ok(
  "区间不重叠且递增",
  findRanges(sample, "金额").every((r, i, all) => i === 0 || r.start >= all[i - 1]!.end),
);

// 2) 计数与旧口径一致（text 类文档的行为不能变）
const oldCount = (text: string, q: string) => (q.trim() ? text.toLowerCase().split(q.trim().toLowerCase()).length - 1 : 0);
const texts = ["金额 金额 金额", "abcABCabc", "aaaa", "aaa", "人员人工 300000 元", "no match here", "", "元元元"];
const queries = ["金额", "abc", "aa", "元", "no", "xyz", " "];
const diffs: string[] = [];
for (const t of texts) {
  for (const q of queries) {
    if (countMatches(t, q) !== oldCount(t, q)) diffs.push(`${t}/${q}: ${countMatches(t, q)} vs ${oldCount(t, q)}`);
  }
}
expect("与旧的 split 计数在纯文本上逐例一致", diffs, []);
expect("countMatches 等于区间数", countMatches(sample, "金额"), findRanges(sample, "金额").length);

// 3) 高亮分段：拼回去必须与原文一字不差
expect("无命中给一整段", splitForHighlight("abc", "z"), [{ text: "abc", hit: false }]);
expect("空查询给一整段", splitForHighlight("abc", ""), [{ text: "abc", hit: false }]);
expect("整段命中", splitForHighlight("AbC", "abc"), [{ text: "AbC", hit: true }]);
expect("开头命中不产生空段", splitForHighlight("金额与底稿", "金额"), [
  { text: "金额", hit: true },
  { text: "与底稿", hit: false },
]);
expect("结尾命中不产生空段", splitForHighlight("与底稿金额", "金额"), [
  { text: "与底稿", hit: false },
  { text: "金额", hit: true },
]);
expect("多段交替", splitForHighlight("a金额b金额c", "金额"), [
  { text: "a", hit: false },
  { text: "金额", hit: true },
  { text: "b", hit: false },
  { text: "金额", hit: true },
  { text: "c", hit: false },
]);
for (const t of [...texts, sample, "Mixed CASE 金额 mixed"]) {
  for (const q of [...queries, "mixed", "金"]) {
    const parts = splitForHighlight(t, q);
    if (parts.map((p) => p.text).join("") !== t) diffs.push(`分段拼接失真: ${t}/${q}`);
    if (q.trim() && parts.filter((p) => p.hit).length !== countMatches(t, q)) {
      diffs.push(`命中段数与计数不符: ${t}/${q}`);
    }
  }
}
expect("分段拼接保真且命中段数等于计数", diffs, []);

// 4) 环形序号
expect("0 折回 0", wrapIndex(0, 5), 0);
expect("末位不变", wrapIndex(4, 5), 4);
expect("越界回绕", wrapIndex(5, 5), 0);
expect("越界多圈", wrapIndex(12, 5), 2);
expect("负数回绕", wrapIndex(-1, 5), 4);
expect("负数多圈", wrapIndex(-6, 5), 4);
expect("长度为 0 给 0", wrapIndex(3, 0), 0);
expect("长度为负给 0", wrapIndex(3, -2), 0);
expect("NaN 给 0", wrapIndex(Number.NaN, 5), 0);
expect("Infinity 给 0", wrapIndex(Number.POSITIVE_INFINITY, 5), 0);
expect("小数截断", wrapIndex(2.7, 5), 2);
expect("下一处", stepIndex(0, 1, 5), 1);
expect("下一处在末位回到开头", stepIndex(4, 1, 5), 0);
expect("上一处在开头回到末尾", stepIndex(0, -1, 5), 4);
expect("跨多圈回原位", stepIndex(2, -5, 5), 2);
expect("大步长前进", stepIndex(0, 7, 5), 2);
expect("旋转角度回绕", wrapIndex(-90, 360), 270);
expect("旋转角度不越界", wrapIndex(720, 360), 0);

// 5) 计数文案
expect("没有命中如实写 0 处", matchLabel(0, 0), "0 处");
expect("总数为负也写 0 处", matchLabel(3, -1), "0 处");
expect("总数 NaN 写 0 处", matchLabel(0, Number.NaN), "0 处");
expect("第一处", matchLabel(0, 3), "1/3");
expect("最后一处", matchLabel(2, 3), "3/3");
expect("越界回到第一处", matchLabel(3, 3), "1/3");
expect("负序号回到最后一处", matchLabel(-1, 3), "3/3");

// 6) 静态走查：不许再出现第二份查找实现
const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, "..", "..", "web", "src");
const reader = fs.readFileSync(path.join(webSrc, "components", "SideReader.tsx"), "utf8");
ok("阅读器从 text-find 导入", reader.includes('from "../text-find.ts"'));
ok("不再用正则 split 做高亮", !reader.includes("text.split(new RegExp"));
ok("不再只标每个文本节点的第一处", !reader.includes("indexOf(lower)"));
ok("DOM 包裹改为遍历区间", reader.includes("const ranges = findRanges(text, q)"));
ok("markdown 命中数以 DOM 的 mark 数为准", reader.includes("mark[data-find]\").length") && reader.includes("setMdMarks"));
ok("不再手写环形取模", !reader.includes("% matchCount) + matchCount") && !reader.includes("+ 360) % 360") && !reader.includes("% tabs.length) + tabs.length"));
ok("计数文案走 matchLabel", reader.includes("matchLabel(findIdx, matchCount)"));
const SPLIT_PROBE = ".toLowerCase().split(";
const componentFiles = fs.readdirSync(path.join(webSrc, "components")).filter((f) => /\.tsx?$/.test(f));
const allComponents = componentFiles
  .filter((f) => fs.readFileSync(path.join(webSrc, "components", f), "utf8").includes(SPLIT_PROBE))
  .sort();
// 这条判据是「扫一遍组件目录、残留必须为空」。它有两种静默失效，两种都给出空数组、都是绿：
// 探针字符串打错一个字符，或者目录/后缀过滤失效导致一个文件都没扫到。所以两头各钉一条。
expect("组件走查确实扫到了文件（不是后缀过滤失效在这儿空跑）", componentFiles.length >= 10, true);
expect(
  "split 探针确实能命中已知违规写法（探针打错一个字符就会永远空、永远绿）",
  "text.toLowerCase().split(q)".includes(SPLIT_PROBE),
  true,
);
expect("组件里不再用 split 数命中次数", allComponents, []);

console.log(`[verify] 阅读器查找检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 阅读器查找口径不符");
  process.exit(1);
}
console.log("[PASS] 阅读器查找正确（命中区间 / 计数与旧口径一致 / 分段保真 / 环形序号 / 计数文案 / 无第二份实现）");
