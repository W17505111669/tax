/**
 * 验证脚本：时间显示口径（相对时间分档 / 坏数据兜底 / 与旧实现逐值一致 /
 * link-check 的空串语义 / 文件名时间戳 / 组件不再各写一份的静态走查）。
 * 运行：pnpm verify:reltime
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dateTimeStamp, dayStamp, fileStamp, relTime } from "../../web/src/time-format.ts";
import { db } from "../src/db.ts";
import { ageText } from "../../web/src/link-check.ts";

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

// 固定时钟：断言可重复，不受跑脚本的时间影响
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

// 1) 分档
expect("此刻是刚刚", relTime(ago(0), NOW), "刚刚");
expect("30 秒前是刚刚", relTime(ago(30_000), NOW), "刚刚");
expect("59.9 秒仍是刚刚", relTime(ago(59_999), NOW), "刚刚");
expect("1 分钟前", relTime(ago(MIN), NOW), "1 分钟前");
expect("59 分钟前", relTime(ago(59 * MIN), NOW), "59 分钟前");
expect("60 分钟进位到小时", relTime(ago(60 * MIN), NOW), "1 小时前");
expect("23 小时前", relTime(ago(23 * HOUR), NOW), "23 小时前");
expect("23 小时 59 分仍算小时", relTime(ago(23 * HOUR + 59 * MIN), NOW), "23 小时前");
expect("24 小时进位到天", relTime(ago(24 * HOUR), NOW), "1 天前");
expect("8 天前", relTime(ago(8 * DAY), NOW), "8 天前");
expect("400 天前不偷偷换成月", relTime(ago(400 * DAY), NOW), "400 天前");
expect("时间在未来按刚刚处理（时钟偏差）", relTime(ago(-5 * MIN), NOW), "刚刚");
expect("不显示负数", relTime(ago(-3 * DAY), NOW).includes("-"), false);

// 2) 坏数据兜底：不猜一个「刚刚」把它藏起来
expect("null 给默认兜底", relTime(null, NOW), "—");
expect("undefined 给默认兜底", relTime(undefined, NOW), "—");
expect("空串给默认兜底", relTime("", NOW), "—");
expect("不是时间给默认兜底", relTime("不是时间", NOW), "—");
expect("非法月份给默认兜底", relTime("2026-13-99T00:00:00Z", NOW), "—");
expect("兜底文案可自定义", relTime(null, NOW, ""), "");
expect("默认 now 参数也能用", typeof relTime(new Date(Date.now() - 5 * MIN).toISOString()), "string");

// 3) 与旧实现逐值一致：档位改的是 link-check 那份，侧栏与看板那份必须一字不差
function oldRel(iso: string, now: number): string {
  const m = Math.floor((now - Date.parse(iso)) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}
const offsets = [0, 1, 30, 59, 60, 61, 90, 120, 1439, 1440, 1441, 2880, 10080, 43200, 576000];
expect(
  "与旧实现在各档位逐值一致",
  offsets.map((m) => relTime(ago(m * MIN), NOW)),
  offsets.map((m) => oldRel(ago(m * MIN), NOW)),
);

// 4) link-check 的 ageText：分档统一，但保留「没有时间 / 时间在未来」返回空串
expect("ageText 采用分钟档", ageText(ago(30 * MIN), NOW), "30 分钟前");
expect("ageText 小时档", ageText("2026-09-28T05:00:00.000Z", NOW), "7 小时前");
expect("ageText 天档", ageText("2026-09-20T12:00:00.000Z", NOW), "8 天前");
expect("ageText 无核验时间返回空串", ageText(null, NOW), "");
expect("ageText 时间在未来返回空串", ageText("2026-09-29T12:00:00.000Z", NOW), "");
expect("ageText 不可解析返回空串", ageText("不是时间", NOW), "");

// 5) 文件名时间戳
const st = fileStamp(new Date(NOW));
expect("时间戳内容", st, "20260928120000");
expect("时间戳长度 14", st.length, 14);
expect("时间戳只有数字（无冒号与 T）", /^\d{14}$/.test(st), true);
expect("默认参数也出 14 位数字", /^\d{14}$/.test(fileStamp()), true);
expect("不含连字符（旧写法会得到 2026-09-28120000）", fileStamp(new Date(NOW)).includes("-"), false);

// 5.1 日期戳
expect("日期戳内容", dayStamp(new Date(NOW)), "2026-09-28");
expect("日期戳接受 ISO 字符串", dayStamp("2026-09-28T05:00:00.000Z"), "2026-09-28");
expect("空串如实返回空串", dayStamp(""), "");
expect("默认参数出 10 位日期", /^\d{4}-\d{2}-\d{2}$/.test(dayStamp()), true);
expect(
  "时间戳前 8 位与日期戳同一天",
  fileStamp(new Date(NOW)).slice(0, 8),
  dayStamp(new Date(NOW)).replace(/-/g, ""),
);

// 6) 静态走查：不许再出现第二份相对时间实现
const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, "..", "..", "web", "src");
const read = (rel: string): string => fs.readFileSync(path.join(webSrc, rel), "utf8");
const sidebar = read("components/Sidebar.tsx");
const overview = read("components/AgentOverview.tsx");
const lc = read("link-check.ts");
const wb = read("components/TaskWorkbench.tsx");
ok("侧栏不再有本地 relTime", !sidebar.includes("function relTime"));
ok("平台总览不再有本地 relTime", !overview.includes("function relTime"));
ok("侧栏从 time-format 导入", sidebar.includes('from "../time-format.ts"'));
ok("平台总览从 time-format 导入", overview.includes('from "../time-format.ts"'));
ok("link-check 委托 relTime", lc.includes('return relTime(iso, now, "")'));
ok("link-check 不再自己分档", !lc.includes('return `${Math.floor(h)} 小时前`'));
ok("工作台不再自己拼时间戳", !wb.includes("slice(0, 19).replace"));
ok("工作台改用 fileStamp", wb.includes("fileStamp()"));
const cv = read("components/CompareView.tsx");
ok("比对视图的文件名走 dayStamp", !cv.includes("slice(0, 10)") && cv.includes("dayStamp("));
// 全组件扫描：日期戳只准从 dayStamp 来，抄一份 slice(0, 10) 就会红
const componentsDir = path.join(webSrc, "components");
const handRolledDate = fs
  .readdirSync(componentsDir)
  .filter((f) => /\.tsx?$/.test(f))
  .filter((f) =>
    fs.readFileSync(path.join(componentsDir, f), "utf8").includes("new Date().toISOString().slice(0, 10)"),
  )
  .sort();
expect("组件里不再自己切日期戳", handRolledDate, []);

// ---- 完整日期时间：31 处内联收成一份，兜底也统一 ----
// 这个格式串此前在 apps/web/src 与 apps/api/scripts 里内联了 31 处（11 个文件），而对「解析
// 不出来」的处置有四种：delivery-artifacts 与 delivery-cite 压根没兜底（空值会把 "Invalid Date"
// 这个英文错误串直接写进对外交付 MD）、evidence-sheet 返回空串、file-parse 返回「—」、
// delivery-docref 靠外层条件把整个括号跳过。本轮先接上交付路径那 5 处，组件里那 26 处留下一轮。
const probe = dateTimeStamp("2026-09-29T02:00:00.000Z");
expect("正常时间给出 zh-CN 24 小时制的完整日期时间", /^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/.test(probe), true);
expect("不出现 12 小时制的 AM/PM", /AM|PM/.test(probe), false);
expect("Date 对象与同一时刻的字符串给出同一个结果", dateTimeStamp(new Date("2026-09-29T02:00:00.000Z")), probe);
expect("空串给兜底、不给 Invalid Date", dateTimeStamp(""), "—");
expect("null 与 undefined 同样给兜底", [dateTimeStamp(null), dateTimeStamp(undefined)], ["—", "—"]);
expect("解析不出来的字符串给兜底（正是那两处没兜底的地方会写进交付 MD 的）", dateTimeStamp("not-a-date"), "—");
expect("兜底文案由调用方指定（台账要空串、交付 MD 要「—」）", dateTimeStamp("", ""), "");
expect(
  "任何输入都不会输出 Invalid Date",
  [dateTimeStamp(""), dateTimeStamp("x"), dateTimeStamp(NaN), dateTimeStamp(null)].some((s) => s.includes("Invalid")),
  false,
);
// 静态走查：交付路径这 5 个模块不再各写一份格式串
const DELIVERY_MODULES = [
  "delivery-artifacts.ts",
  "delivery-cite.ts",
  "delivery-docref.ts",
  "evidence-sheet.ts",
  "file-parse.ts",
];
const webSrcDir = path.resolve(here, "..", "..", "web", "src");
const inlined: string[] = [];
let modulesRead = 0;
for (const f of DELIVERY_MODULES) {
  const src = fs.readFileSync(path.join(webSrcDir, f), "utf8");
  if (src.length > 500) modulesRead += 1;
  if (src.includes('toLocaleString("zh-CN"')) inlined.push(f);
}
expect("5 个交付模块都真读到了（静态走查不能空跑）", modulesRead, DELIVERY_MODULES.length);
expect("交付路径上不再内联日期时间格式串", inlined, []);

// 真实数据走查：上面那些兜底当前一次都不会触发——库里 6 张表的时间列全部可解析。
// 这条把「隐含前提」变成常驻断言：写入侧哪天落了个空值或坏格式，界面与交付 MD 上就会出现
// "Invalid Date"，而这条会先红。31 处内联写法都默认了这个前提成立，此前没有任何门禁核过它。
const TIME_COLUMNS: Array<[string, string]> = [
  ["tasks", "created_at"],
  ["files", "created_at"],
  ["tool_calls", "started_at"],
  ["events", "at"],
  ["ref_checks", "checked_at"],
  ["link_checks", "checked_at"],
];
let timeRows = 0;
const timeBad: string[] = [];
for (const [t, col] of TIME_COLUMNS) {
  const rows = db.prepare(`SELECT ${col} AS v FROM ${t}`).all() as Array<{ v: string | null }>;
  for (const r of rows) {
    timeRows += 1;
    const v = r.v === null ? "" : String(r.v);
    if (v === "" || !Number.isFinite(Date.parse(v))) timeBad.push(`${t}.${col}=${v === "" ? "(空)" : v}`);
  }
}
expect("时间列走查确实走到了行（不是空跑）", timeRows > 0, true);
expect("库里每一行的时间字段都可解析（否则界面与交付 MD 上会出现 Invalid Date）", timeBad, []);
console.log(
  `[verify] 时间字段完整性走查：${TIME_COLUMNS.length} 张表 ${timeRows} 行 · 空或解析失败 ${timeBad.length} 行`,
);

console.log(`[verify] 时间显示口径检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 时间显示口径不符");
  process.exit(1);
}
console.log("[PASS] 时间显示口径正确（分档 / 坏数据兜底 / 与旧实现一致 / 时间戳 / 无第二份实现）");
