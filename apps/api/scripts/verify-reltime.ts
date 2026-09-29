/**
 * 验证脚本：时间显示口径（相对时间分档 / 坏数据兜底 / 与旧实现逐值一致 /
 * link-check 的空串语义 / 文件名时间戳 / 组件不再各写一份的静态走查）。
 * 运行：pnpm verify:reltime
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dayStamp, fileStamp, relTime } from "../../web/src/time-format.ts";
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

console.log(`[verify] 时间显示口径检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 时间显示口径不符");
  process.exit(1);
}
console.log("[PASS] 时间显示口径正确（分档 / 坏数据兜底 / 与旧实现一致 / 时间戳 / 无第二份实现）");
