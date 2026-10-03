/**
 * 验证脚本：数字与单位的排版口径（去零 / 百分比取值与文案 / 单位空隙 / 字节数 / 与文档口径一致 /
 * 组件不再各自 round 的静态走查）。
 * 运行：pnpm verify:format
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fmtDurationShort,
  fmtDurationZh,
  fmtMs,
  fmtSecondsShort,
  groupNumber,
  moneyText,
  needsUnitSpace,
  percentFrom,
  percentOf,
  percentText,
  percentValue,
  trimZeros,
} from "../../web/src/format.ts";
import { fmtBytes } from "../../web/src/run-artifacts.ts";
import { fmtDuration } from "../../web/src/run-tools.ts";
import { policyHint } from "../../web/src/upload-policy.ts";

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

// 1) 去零：整数不能被削
expect("两位零去掉", trimZeros("25.00"), "25");
expect("一位零去掉", trimZeros("1.20"), "1.2");
expect("有效小数保留", trimZeros("1.23"), "1.23");
expect("整数不动（100 不能变 1）", trimZeros("100"), "100");
expect("10 不动", trimZeros("10"), "10");
expect("全零小数变 0", trimZeros("0.00"), "0");
expect("空串原样", trimZeros(""), "");
expect("负数也能去零", trimZeros("-1.50"), "-1.5");
expect("小数点后无零不动", trimZeros("0.5"), "0.5");

// 2) 百分比取值
expect("两位小数", percentOf(106, 112), 94.64);
expect("一位小数", percentOf(106, 112, 1), 94.6);
expect("整数", percentOf(106, 112, 0), 95);
expect("三分之一两位小数", percentOf(1, 3), 33.33);
expect("三分之二两位小数", percentOf(2, 3), 66.67);
expect("全部成功是 100", percentOf(5, 5), 100);
expect("分子为 0 是 0 而不是 null", percentOf(0, 5), 0);
expect("分母为 0 如实给 null", percentOf(5, 0), null);
expect("负分子如实给 null", percentOf(-1, 5), null);
expect("NaN 如实给 null", percentOf(Number.NaN, 5), null);
expect("Infinity 如实给 null", percentOf(Number.POSITIVE_INFINITY, 5), null);
expect("与文档里旧公式一致", percentOf(106, 112), Math.round((106 / 112) * 10000) / 100);
expect("与旧公式在边界值一致", percentOf(1, 3), Math.round((1 / 3) * 10000) / 100);

// 3) 百分比文案：算不出来不能写成「—%」
expect("数值文案", percentValue(106, 112), "94.64");
expect("数值文案兜底", percentValue(0, 0), "—");
expect("完整文案", percentText(106, 112), "94.64%");
expect("完整文案兜底不带百分号", percentText(0, 0), "—");
expect("百分号紧贴数字", percentText(1, 2).includes(" %"), false);
expect("已有数值转文案", percentFrom(50), "50%");
expect("已有数值去零", percentFrom(60.0), "60%");
expect("已有数值保留小数", percentFrom(94.64), "94.64%");
expect("null 转破折号", percentFrom(null), "—");
expect("undefined 转破折号", percentFrom(undefined), "—");
expect("NaN 转破折号", percentFrom(Number.NaN), "—");
expect("0 是 0% 不是破折号", percentFrom(0), "0%");
// percentText 此前自己拼 `${v}%`，等于「数值 → 百分比文案」有两份实现：去零规则改了 percentFrom
// 不会带动 percentText。现在它委托 percentFrom，这里把委托钉住——改回自己拼就会红。
const PERCENT_CASES: Array<[number, number, number]> = [
  [106, 112, 2],
  [106, 112, 1],
  [106, 112, 0],
  [1, 3, 2],
  [2, 3, 2],
  [5, 5, 2],
  [0, 5, 2],
  [60, 100, 2],
];
expect(
  "percentText 与 percentFrom∘percentOf 逐字相同（小数位与去零都跟着走）",
  PERCENT_CASES.map(([a, b, d]) => percentText(a, b, d)),
  PERCENT_CASES.map(([a, b, d]) => percentFrom(percentOf(a, b, d))),
);
expect(
  "算不出来时两边都给「—」（不会一边「—」一边「—%」）",
  [percentText(5, 0), percentText(-1, 5), percentFrom(percentOf(5, 0))],
  ["—", "—", "—"],
);
// 4) 数字与单位的空隙
expect("中文单位留空隙", needsUnitSpace("个"), true);
expect("份留空隙", needsUnitSpace("份"), true);
expect("次留空隙", needsUnitSpace(" 次"), true);
expect("百分号紧贴", needsUnitSpace("%"), false);
expect("全角百分号也紧贴", needsUnitSpace("％"), false);
expect("复合单位以百分号开头也紧贴", needsUnitSpace("% · 累计 60%"), false);
expect("空单位不需要空隙", needsUnitSpace(""), false);
expect("纯空格单位不需要空隙", needsUnitSpace("   "), false);

// 5) 字节数：整数不带小数
expect("0 字节", fmtBytes(0), "0 B");
expect("小于 1K", fmtBytes(512), "512 B");
expect("整 1K", fmtBytes(1024), "1 KB");
expect("1.5K 保留一位", fmtBytes(1536), "1.5 KB");
expect("整 25M 不写 25.00", fmtBytes(25 * 1024 * 1024), "25 MB");
expect("1.5M 保留一位", fmtBytes(1.5 * 1024 * 1024), "1.5 MB");
expect("非整 M 保留两位", fmtBytes(1.234 * 1024 * 1024), "1.23 MB");
expect("负数如实给破折号", fmtBytes(-1), "—");
expect("NaN 如实给破折号", fmtBytes(Number.NaN), "—");
expect(
  "上传提示里不出现 25.00",
  policyHint({ allowedExtensions: ["pdf"], maxUploadBytes: 25 * 1024 * 1024 }).includes("25.00"),
  false,
);
expect(
  "上传提示写出 25 MB",
  policyHint({ allowedExtensions: ["pdf"], maxUploadBytes: 25 * 1024 * 1024 }).includes("25 MB"),
  true,
);

// 6) 静态走查：组件不再各自 round，也不再拼出「—%」
const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, "..", "..", "web", "src");
const overview = fs.readFileSync(path.join(webSrc, "components", "AgentOverview.tsx"), "utf8");
ok(
  "平台总览改用共用格式化（percentText/percentFrom + percentValue），不自己拼百分号",
  (overview.includes("percentText(") || overview.includes("percentFrom(")) && overview.includes("percentValue("),
);
// 工具成功率的分母必须是「有返回结果的调用」。ok IS NULL 的那批是进程被打断、从未返回结果的
// 调用，用 toolCalls 当分母等于把「没有结果」算成「结果是错误」（口径见 web/src/tool-outcome.ts）
ok(
  "工具成功率的分母不是调用总数",
  !overview.includes("percentValue(stats.platform.toolOk, stats.platform.toolCalls)") &&
    !overview.includes("percentText(p.toolOk, p.toolCalls)") &&
    overview.includes("resolvedCalls("),
);
ok(
  "三态计数与环图分段走 tool-outcome.ts 那一份共用口径",
  overview.includes("../tool-outcome.ts") && overview.includes("ringSegments(") && overview.includes("outcomeLine("),
);
ok("不再自己写 *10000/100", !overview.includes("* 10000) / 100"));
ok("不再自己写 *1000/10", !overview.includes("* 1000) / 10"));
ok("完成率改用 percentOf", !overview.includes("Math.round((pa.completed / pa.tasks) * 100)"));
ok("KPI 单位按 needsUnitSpace 决定空隙", overview.includes("needsUnitSpace(kpi.unit)"));
ok("不再拼出「—%」", !overview.includes('?? "—"}%'));
ok("OCR 单位带分隔空格", overview.includes("% · ${stats.platform.ocrRuns} 次"));
const runArt = fs.readFileSync(path.join(webSrc, "run-artifacts.ts"), "utf8");
ok("字节数走 trimZeros", runArt.includes("trimZeros("));

// 7) 时长：三种场合三种写法，但每种只有一份实现
expect("中文时长一位小数", fmtDurationZh(12.34), "12.3 秒");
expect("中文时长取整", fmtDurationZh(12.34, 0), "12 秒");
expect("满 90 秒进位到分钟", fmtDurationZh(90), "2 分钟");
expect("150 秒写成 3 分钟", fmtDurationZh(150), "3 分钟");
expect("0 秒如实写 0.0 秒", fmtDurationZh(0), "0.0 秒");
expect("负时长给破折号", fmtDurationZh(-1), "—");
expect("NaN 时长给破折号", fmtDurationZh(Number.NaN), "—");
expect("紧凑角标整数秒", fmtDurationShort(12.4), "12s");
expect("紧凑角标 89.6 秒四舍五入到 90s", fmtDurationShort(89.6), "90s");
expect("紧凑角标满 90 秒用 m", fmtDurationShort(90), "2m");
expect("紧凑角标 150 秒", fmtDurationShort(150), "3m");
expect("紧凑角标负数给破折号", fmtDurationShort(-1), "—");
expect("紧凑小数写法", fmtSecondsShort(1.234), "1.2s");
expect("紧凑小数写法可取整", fmtSecondsShort(120, 0), "120s");
expect("毫秒不足一秒用 ms", fmtMs(320), "320 ms");
expect("毫秒换算成秒保留一位", fmtMs(3500), "3.5 s");
expect("整秒也保留一位（时长口径不去零）", fmtMs(1000), "1.0 s");
expect("毫秒为 null 给破折号", fmtMs(null), "—");
expect("毫秒为负给破折号", fmtMs(-5), "—");
expect("毫秒为 NaN 给破折号", fmtMs(Number.NaN), "—");
expect("run-tools 的耗时与统一口径一致", [fmtDuration(null), fmtDuration(320), fmtDuration(3500)], [
  fmtMs(null),
  fmtMs(320),
  fmtMs(3500),
]);
expect("文档口径单位前留空格", fmtMs(3500).includes(" s"), true);
expect("角标口径单位紧贴", fmtSecondsShort(1.5).includes(" s"), false);
expect("中文口径数字与单位之间留空格", fmtDurationZh(1.5).includes(" 秒"), true);
const workbench = fs.readFileSync(path.join(webSrc, "components", "TaskWorkbench.tsx"), "utf8");
ok("工作台改用统一时长函数", workbench.includes("fmtDurationZh(") && workbench.includes("fmtDurationShort("));
ok("工作台不再自己拼分钟", !workbench.includes("Math.round(s / 60)} 分钟"));
ok("工作台不再自己拼紧凑秒", !workbench.includes("toFixed(0)}s") && !workbench.includes("toFixed(1)}s"));
const runTools = fs.readFileSync(path.join(webSrc, "run-tools.ts"), "utf8");
ok("run-tools 的耗时委托给 format.ts", runTools.includes("return fmtMs(ms);"));

// ---- 千分位与金额：门禁与界面必须用同一个函数 ----
// 此前 toLocaleString("zh-CN") 内联了 10 处，其中最要紧的是 scan:uimd 的**期望值**与看板 KPI 卡
// 的**渲染值**各格式化一遍：两边各自维护格式串，改一边就假红、两边一起改就假绿（它比的是字符串，
// 一起错就一起过）。金额那一档（比对页）用的是两位小数的选项，也各写了一份。
expect("千分位", groupNumber(1234567), "1,234,567");
expect("0 与负数", [groupNumber(0), groupNumber(-1234)], ["0", "-1,234"]);
expect(
  "非有限值给「—」而不是 NaN（这个字符串会直接上看板与交付材料）",
  [groupNumber(NaN), groupNumber(Infinity)],
  ["—", "—"],
);
expect("金额固定两位小数并带千分位", moneyText(1234.5), "1,234.50");
expect("金额的非有限值同样给「—」", moneyText(NaN), "—");

// 全库走查：日期时间与数字的格式化只许在 time-format.ts 与 format.ts 里各留一份。
// 刻意不点名清单——点名会腐化（新文件不在清单里就管不到），所以直接遍历目录。
const FMT_DIRS = [path.resolve(here, "..", "..", "web", "src"), path.resolve(here, "..", "src")];
const FMT_ALLOWED = new Set(["time-format.ts", "format.ts"]);
const INLINE_FMT = /toLocaleString\(\s*"zh-CN"/;
// 阳性对照：这条走查断的是「offenders 必须为空」，模式写废（少个转义、引号种类写错、
// 忘了 zh-CN 大小写）就永远空、永远绿，而 `fmtFiles > 30` 那条防空跑断言查的是文件那一侧，
// 查不出模式坏了。所以拿已知违规与已知合规的两个样本各断一次。
expect("内联格式化的模式确实能命中已知违规写法", INLINE_FMT.test(`n.toLocaleString("zh-CN")`), true);
expect("内联格式化的模式不误伤合规写法", INLINE_FMT.test("groupNumber(n)"), false);
const offenders: string[] = [];
let fmtFiles = 0;
const walkFmt = (dir: string): void => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkFmt(p);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(e.name) || FMT_ALLOWED.has(e.name)) continue;
    fmtFiles += 1;
    if (INLINE_FMT.test(fs.readFileSync(p, "utf8"))) {
      offenders.push(path.relative(path.resolve(here, "..", ".."), p));
    }
  }
};
for (const d of FMT_DIRS) walkFmt(d);
expect("格式化走查确实走到了文件（不是空跑）", fmtFiles > 30, true);
expect("界面与服务端都不再内联 toLocaleString（只留 format.ts / time-format.ts 两份实现）", offenders, []);
console.log(`[verify] 格式化实现点走查：${fmtFiles} 个 .ts/.tsx 文件 · 内联残留 ${offenders.length} 处`);

// 走查二：format.ts 导出的每个格式化函数都必须真有**运行时**消费点。
// 本轮查出来的：percentText 此前零消费点，只有本脚本在测它——**测过 ≠ 有人用**，它是全库唯一
// 一个「门禁看着最有保障、实际没人拿它渲染」的格式化函数。死导出的坏处不是浪费字节，是下一个人
// 按名字挑中它（percentText 比 percentFrom(percentOf(...)) 顺手得多），从而绕开这边的口径。
// 上面那组等值断言抓不住「改回自己拼」：percentOf 返回的是 Math.round(x*f)/f，String() 出来
// 永远没有多余的零，所以自己拼 `${v}%` 与走 trimZeros 的 percentFrom 结果逐字相同——等值恒真。
// 真正要钉的是**实现只有一份**，所以直接查源码：percentText 的函数体必须调 percentFrom、且不含 % 字面量。
const fmtSrc = fs.readFileSync(path.join(webSrc, "format.ts"), "utf8");
const bodyOf = (name: string): string =>
  new RegExp(`export function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(fmtSrc)?.[1] ?? "";
expect("确实取到了 percentText 的函数体（不是正则失效在这儿空跑）", bodyOf("percentText").length > 0, true);
expect("percentText 委托 percentFrom（「数值 → 百分比文案」全库只许有一份实现）", bodyOf("percentText").includes("percentFrom("), true);
expect("percentText 自己不再拼 % 字面量", /%/.test(bodyOf("percentText")), false);
const fmtExports = [...fmtSrc.matchAll(/^export function (\w+)/gm)].map((m) => m[1] ?? "");
/**
 * 「消费点」必须是真调用，不能是 import 行或注释里提一嘴。这个漏洞是变异测试当场抓到的：
 * 把 percentText 的两处调用都改回 `percentOf(...) ?? 0` 之后，AgentOverview 的 import 行和一句
 * 注释里还留着 percentText 这个词，走查就以为它有人用、照样绿。所以先剥掉 import 与注释再找名字。
 */
const stripNoise = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/import\s+[\s\S]*?from\s*["'][^"']*["'];?/g, "");
const runtimeChunks: string[] = [];
const walkRuntime = (dir: string): void => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkRuntime(p);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(e.name) || e.name === "format.ts") continue;
    runtimeChunks.push(stripNoise(fs.readFileSync(p, "utf8")));
  }
};
for (const d of FMT_DIRS) walkRuntime(d);
const runtimeSrc = runtimeChunks.join("\n");
const unusedExports = fmtExports.filter((n) => n !== "" && !new RegExp(`\\b${n}\\b`).test(runtimeSrc));
expect("确实取到了 format.ts 的导出（不是正则失效在这儿空跑）", fmtExports.length >= 10, true);
expect("剥掉 import 与注释后确实还剩代码（不是把文件剥空了、于是所有导出都算「有人用」的反面）", runtimeSrc.length > 10000, true);
expect("format.ts 的每个导出都真有运行时消费点（导出了没人渲染的格式化函数＝下一个人会挑中的坑）", unusedExports, []);
console.log(`[verify] format.ts 导出消费点走查：${fmtExports.length} 个导出 · 零消费点 ${unusedExports.length} 个`);

// 走查三：percentOf 算不出来时给 null，这是它的契约（「成功率 0%」和「没有调用」是两件事）。
// 所以 `?? 0` 只许出现在一个地方：把 null 兜成 0 之后**只用于几何尺寸**（条宽、扇形角度），
// 约定是赋值目标名含 width。`const rate = percentOf(...) ?? 0` 再渲染成 `${rate}%`，
// 就是把「还没有任务」说成「完成率 0%」——本轮界面上 1 处、下载的概览快照 MD 里 1 处都是这么写的。
const WIDTH_TARGET = /(?:const|let)\s+\w*[Ww]idth\w*\s*=/;
/**
 * 走查四：百分比文案不许自己拼。「数值 → 百分比文案」全库只许 format.ts 的 percentFrom 一份实现。
 * 此前运行时目录里有 13 处裸拼（`${t.accuracyPercent}%`、JSX 里 `{s.accuracyPercent}%`），
 * 其中 tool-outcome.ts 与 AgentOverview 的 SVG 圆心标签还是 format.ts 之外的两份完整实现
 * （各自写了一遍 `rate === null ? "—" : ...`）。裸拼今天没出事，只因为这些字段类型恰好是非空
 * number；哪天某个比率改成 `number | null`，界面与下载的交付 MD 上就会直接出现「null%」。
 * 例外只有一类：CSS 几何属性（条宽、扇形角度）确实需要一个数，那不是文案。
 */
const BARE_PCT = /\{[A-Za-z_$][\w.$?\[\]]*\}%/;
const CSS_GEOM = /(width|height|left|right|top|bottom|flex|basis|offset)\s*:/i;
const barePct: string[] = [];
let codeLines = 0;
const percentOfSites: string[] = [];
const badNullDefault: string[] = [];
const walkPct = (dir: string): void => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkPct(p);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(e.name) || e.name === "format.ts") continue;
    const rel = path.relative(path.resolve(here, "..", ".."), p);
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      // 行尾注释不是渲染路径，先剥掉再判（本轮 tool-outcome.ts 的说明注释里就带着 `${rate}%` 样本）
      const text = (lines[i] ?? "").replace(/\/\/.*$/, "");
      codeLines += 1;
      const at = `${rel}:${i + 1}`;
      if (text.includes("percentOf(")) {
        percentOfSites.push(at);
        if (/\?\?\s*0\b|\|\|\s*0\b/.test(text) && !WIDTH_TARGET.test(text)) badNullDefault.push(at);
      }
      if (BARE_PCT.test(text) && !CSS_GEOM.test(text)) barePct.push(at);
    }
  }
};
for (const d of FMT_DIRS) walkPct(d);
expect("percentOf 走查确实走到了调用点（不是空跑）", percentOfSites.length >= 1, true);
expect("percentOf 的 null 没有被 ?? 0 兜底成「0%」（只许兜给名字含 width 的几何尺寸变量）", badNullDefault, []);
// 正则本身也要自检：写废了的正则会让这条走查永远绿，而它绿的樣子与「全库都合规」一模一样
expect("裸拼 % 的正则确实能命中样本（不是正则写废了在这儿空跑）", [BARE_PCT.test("`${rate}%`"), BARE_PCT.test("{rate}%"), BARE_PCT.test("percentFrom(rate)")], [true, true, false]);
expect("裸拼 % 的走查确实扫到了代码行（不是目录空了在这儿空跑）", codeLines > 1000, true);
expect("界面与服务端都不再自己拼百分号（「数值 → 百分比文案」只留 percentFrom 一份实现）", barePct, []);
console.log(
  `[verify] percentOf 调用点走查：${percentOfSites.length} 处 · 把 null 兜成 0 当文案的 ${badNullDefault.length} 处 · 裸拼 % 残留 ${barePct.length} 处（扫了 ${codeLines} 行）`,
);

console.log(`[verify] 数字与单位排版检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 数字与单位排版口径不符");
  process.exit(1);
}
console.log(
  "[PASS] 数字与单位排版正确（去零 / 百分比取值与兜底 / 单位空隙 / 字节数 / 组件不再各自 round / 导出无死代码 / null 不被兜成 0% / 百分号只由 percentFrom 拼）",
);
