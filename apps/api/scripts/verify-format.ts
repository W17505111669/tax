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
ok("平台总览改用 percentText/percentValue", overview.includes("percentText(") && overview.includes("percentValue("));
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

console.log(`[verify] 数字与单位排版检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 数字与单位排版口径不符");
  process.exit(1);
}
console.log("[PASS] 数字与单位排版正确（去零 / 百分比取值与兜底 / 单位空隙 / 字节数 / 组件不再各自 round）");
