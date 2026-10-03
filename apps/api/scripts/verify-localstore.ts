/**
 * 验证脚本：本地存储统一入口（原始读写与内存兜底 / 形状校验 / 脏数据回落 /
 * 收藏与排序这类跨组件共享键 / 键登记 / 前端不再直接碰 localStorage 的静态走查）。
 * 运行：pnpm verify:localstore
 *
 * Node 里没有 localStorage，local-store 会自动落到内存兜底——正好把「存储不可用」
 * 这条降级路径也一起验证了。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  asBoolRecord,
  asSnapshotRecord,
  asSortRecord,
  asStringArray,
  asStringArrayRecord,
  asStringRecord,
  clearStarred,
  isStarred,
  KEYS,
  localFootprint,
  readEnum,
  readJson,
  readRaw,
  readStarred,
  readTaskOrder,
  readText,
  removeRaw,
  resetAllLocal,
  resetUiPreferences,
  toggleStarred,
  UI_PREFERENCE_KEYS,
  USER_DATA_KEYS,
  writeJson,
  writeRaw,
  writeStarred,
  writeTaskOrder,
} from "../../web/src/local-store.ts";
import { CUSTOM_NOTE_STORE_KEY } from "../../web/src/amount-note.ts";
import { loadTags, saveTags } from "../../web/src/tags.ts";

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

// 1) 原始读写与降级
writeRaw("t.raw", "甲");
expect("写入后读回", readRaw("t.raw"), "甲");
expect("没写过的键返回 null", readRaw("t.nope"), null);
expect("readText 缺失时给默认值", readText("t.nope", "兜底"), "兜底");
expect("readText 有值时给原值", readText("t.raw", "兜底"), "甲");
removeRaw("t.raw");
expect("删除后读回 null", readRaw("t.raw"), null);
writeRaw("t.raw2", "1");
removeRaw("t.raw2");
removeRaw("t.raw2");
ok("重复删除不抛错", true);
ok("没有 localStorage 时写入不抛错（内存兜底）", readRaw("t.raw2") === null);

// 2) 形状校验
expect("字符串数组原样", asStringArray(["a", "b"]), ["a", "b"]);
expect("字符串数组剔除非字符串", asStringArray(["a", 1, null, "b"]), ["a", "b"]);
expect("字符串数组拒绝非数组", asStringArray({ 0: "a" }), null);
expect("空数组是合法值", asStringArray([]), []);
expect("字符串字典原样", asStringRecord({ a: "甲", b: "乙" }), { a: "甲", b: "乙" });
expect("字符串字典剔除非字符串值", asStringRecord({ a: "甲", b: 2 }), { a: "甲" });
expect("字符串字典拒绝数组", asStringRecord(["a"]), null);
expect("字符串字典拒绝 null", asStringRecord(null), null);
expect("布尔字典只留布尔", asBoolRecord({ a: true, b: "yes", c: false }), { a: true, c: false });
expect("字符串数组字典", asStringArrayRecord({ t1: ["a", 1], t2: "x", t3: [] }), { t1: ["a"], t3: [] });
expect(
  "排序字典只认 1 与 -1",
  asSortRecord({ s1: { col: "金额", dir: 1 }, s2: { col: "地址", dir: 0 }, s3: { col: 3, dir: -1 }, s4: "x" }),
  { s1: { col: "金额", dir: 1 } },
);
expect(
  "快照字典剔除非数值与非有限数",
  asSnapshotRecord({ "2026-09-29": { tasks: 24, bad: "x", nan: Number.NaN }, junk: 1, arr: [1] }),
  { "2026-09-29": { tasks: 24 } },
);
expect("快照字典拒绝非对象", asSnapshotRecord("x"), null);

// 3) readJson 兜底：脏数据不能把异常抛进 render
expect("缺失键回落", readJson("t.j1", asStringArray, ["默认"]), ["默认"]);
writeRaw("t.j2", "");
expect("空串回落", readJson("t.j2", asStringArray, ["默认"]), ["默认"]);
writeRaw("t.j3", "{坏数据");
expect("坏 JSON 回落", readJson("t.j3", asStringArray, ["默认"]), ["默认"]);
writeRaw("t.j4", JSON.stringify({ a: 1 }));
expect("形状不对回落", readJson("t.j4", asStringArray, ["默认"]), ["默认"]);
writeRaw("t.j5", JSON.stringify(["甲", 2, "乙"]));
expect("合规部分保留", readJson("t.j5", asStringArray, []), ["甲", "乙"]);
writeJson("t.j6", { a: ["x"] });
expect("writeJson 往返", readJson("t.j6", asStringArrayRecord, {}), { a: ["x"] });
const cyclic: Record<string, unknown> = { name: "自引用" };
cyclic.self = cyclic;
writeJson("t.j7", cyclic);
ok("循环引用写入不抛错", true);

// 4) readEnum：白名单外一律回落，不放宽
writeRaw("t.e1", "mismatch");
expect("白名单内取原值", readEnum("t.e1", ["all", "mismatch"] as const, "all"), "mismatch");
writeRaw("t.e2", "MISMATCH");
expect("大小写不同也回落", readEnum("t.e2", ["all", "mismatch"] as const, "all"), "all");
writeRaw("t.e3", "{脏");
expect("脏值回落", readEnum("t.e3", ["all", "mismatch"] as const, "all"), "all");
expect("缺失回落", readEnum("t.e4", ["all", "mismatch"] as const, "all"), "all");

// 5) 收藏：侧栏与工作台共用同一个键，必须同一份实现
clearStarred();
expect("清空后收藏为空", [...readStarred()], []);
writeStarred(["t1", "t2", "t2"]);
expect("写入时去重", [...readStarred()], ["t1", "t2"]);
expect("isStarred 命中", isStarred("t1"), true);
expect("isStarred 未命中", isStarred("t9"), false);
expect("翻转后为真", toggleStarred("t9"), true);
expect("再翻转回假", toggleStarred("t9"), false);
expect("翻转已有项会移除", toggleStarred("t1"), false);
expect("移除后只剩 t2", [...readStarred()], ["t2"]);
writeRaw(KEYS.starred, "不是 JSON");
expect("脏数据时收藏回落为空而不是抛错", [...readStarred()], []);
writeRaw(KEYS.starred, JSON.stringify({ t2: true }));
expect("旧格式（对象）也回落为空", [...readStarred()], []);
expect("脏数据下 isStarred 为假", isStarred("t2"), false);
clearStarred();
expect("清空写回空数组", readRaw(KEYS.starred), "[]");

// 6) 手动排序：空清单不留空壳
writeTaskOrder(["a", "b"]);
expect("排序往返", readTaskOrder(), ["a", "b"]);
writeTaskOrder([]);
expect("清空后键被删掉", readRaw(KEYS.taskOrder), null);
expect("清空后读回空数组", readTaskOrder(), []);
writeRaw(KEYS.taskOrder, "{坏");
expect("排序脏数据回落空数组", readTaskOrder(), []);

// 7) 任务标签（tags.ts 走同一入口）
saveTags({ t1: ["研发", "加计"], t2: [] });
expect("标签往返", loadTags(), { t1: ["研发", "加计"], t2: [] });
writeRaw(KEYS.tags, "{坏");
expect("标签脏数据回落空对象", loadTags(), {});
writeRaw(KEYS.tags, JSON.stringify({ t1: ["研发", 3], t2: "不是数组" }));
expect("标签只留合规部分", loadTags(), { t1: ["研发"] });
saveTags({});
expect("标签可清空", loadTags(), {});

// 8) 键登记
const keyValues = Object.values(KEYS);
expect("键值两两不同", new Set(keyValues).size, keyValues.length);
expect("键都带命名空间前缀", keyValues.every((k) => k.startsWith("tax")), true);
expect("备注模板键与 amount-note 同一份定义", KEYS.customNoteTemplates, CUSTOM_NOTE_STORE_KEY);
ok("收藏键名沿用既有值（升级不丢用户数据）", KEYS.starred === "taxai-starred");
ok("标签键名沿用既有值", KEYS.tags === "taxai-tags");
ok("快照键名沿用既有值", KEYS.snapshots === "taxai-stats-snapshots");
ok("版式主题键名沿用既有值", KEYS.paperTheme === "tax-paper-theme");

// 9) 静态走查：前端不许再绕过这个入口
const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, "..", "..", "web", "src");
const files: string[] = [];
(function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name)) files.push(p);
  }
})(webSrc);
ok("确实扫到了前端源码", files.length > 20, `${files.length} 个文件`);
const DIRECT_LS = /\blocalStorage\b\s*[.[]/;
const STARRED_PROBE = '"taxai-starred"';
const TAGS_PROBE = '"taxai-tags"';
// 阳性对照：下面三条断的都是「列表必须为空」，判据一个是正则、两个是字符串字面量。正则少个 \b、
// 字面量少个引号或键名改了，列表就永远空、永远绿，绿的样子与「前端确实都走 local-store 这一个
// 入口」一模一样；`files.length > 20` 那条防空跑断言查的是文件那一侧，查不出判据坏了。
// 两个键名探针不取样例字符串，而是直接断它等于 JSON.stringify(KEYS.x)：KEYS 是唯一权威来源，
// 探针与它同源，改键名时两边一起动，否则这条走查会静默失效。
expect("localStorage 探针确实能命中点号写法", DIRECT_LS.test("localStorage.getItem(KEYS.starred)"), true);
expect("localStorage 探针确实能命中下标写法", DIRECT_LS.test('localStorage["taxai-starred"]'), true);
expect("localStorage 探针不误伤别的标识符", DIRECT_LS.test("const scopedStorage = { getItem: 1 }"), false);
expect("收藏键探针确实等于真实键名（与 KEYS 同源，否则走查静默失效）", STARRED_PROBE, JSON.stringify(KEYS.starred));
expect("标签键探针确实等于真实键名（与 KEYS 同源，否则走查静默失效）", TAGS_PROBE, JSON.stringify(KEYS.tags));
const direct = files
  .filter((f) => path.basename(f) !== "local-store.ts")
  .filter((f) => DIRECT_LS.test(fs.readFileSync(f, "utf8")))
  .map((f) => path.relative(webSrc, f).replace(/\\/g, "/"))
  .sort();
expect("除 local-store 外没有文件直接碰 localStorage", direct, []);
const starredLiterals = files
  .filter((f) => path.basename(f) !== "local-store.ts")
  .filter((f) => fs.readFileSync(f, "utf8").includes(STARRED_PROBE))
  .map((f) => path.relative(webSrc, f).replace(/\\/g, "/"));
expect("收藏键的字面量只在 local-store 里", starredLiterals, []);
const tagsLiterals = files
  .filter((f) => path.basename(f) !== "local-store.ts")
  .filter((f) => fs.readFileSync(f, "utf8").includes(TAGS_PROBE))
  .map((f) => path.relative(webSrc, f).replace(/\\/g, "/"));
expect("标签键的字面量只在 local-store 里", tagsLiterals, []);
for (const rel of ["tags.ts", "hooks/usePaperTheme.ts", "components/Sidebar.tsx", "components/SideReader.tsx", "components/TaskWorkbench.tsx", "components/AgentOverview.tsx", "components/CompareView.tsx", "components/ReviewView.tsx"]) {
  const src = fs.readFileSync(path.join(webSrc, rel.replace(/\//g, path.sep)), "utf8");
  ok(`${rel} 从 local-store 导入`, src.includes('local-store.ts"'));
}

// 10) 复位：界面偏好与用户数据必须分开，一键清掉人家写下的东西是不可接受的
writeRaw(KEYS.resultFontSize, "lg");
writeRaw(KEYS.readerGroup, "gens");
writeStarred(["t1"]);
saveTags({ t1: ["研发"] });
writeRaw(KEYS.customNoteTemplates, JSON.stringify({ "rd-audit": [{ label: "自定义", text: "与本项目专项台账核对一致" }] }));
writeJson(KEYS.snapshots, { "2026-09-29": { tasks: 1 } });
let foot = localFootprint();
ok("统计到的键数不少于刚写入的 6 项", foot.keys >= 6, JSON.stringify(foot));
expect("用户数据算 4 项", foot.data, 4);
ok("字节数大于 0", foot.bytes > 0, String(foot.bytes));
const clearedUi = resetUiPreferences();
ok(
  "复位偏好返回实际清掉的键",
  clearedUi.includes(KEYS.resultFontSize) && clearedUi.includes(KEYS.readerGroup),
  clearedUi.join(","),
);
expect("复位后字号回到默认", readText(KEYS.resultFontSize), "");
expect("复位后阅读器分组回到默认", readText(KEYS.readerGroup), "");
expect("复位偏好不动收藏", [...readStarred()], ["t1"]);
expect("复位偏好不动标签", loadTags(), { t1: ["研发"] });
expect("复位偏好不动自定义备注模板", readRaw(KEYS.customNoteTemplates) !== null, true);
expect("复位偏好不动指标快照", readRaw(KEYS.snapshots) !== null, true);
foot = localFootprint();
expect("复位后界面偏好归零", foot.ui, 0);
expect("复位后用户数据仍是 4 项", foot.data, 4);
const clearedAll = resetAllLocal();
ok("全部清空返回实际清掉的键", clearedAll.includes(KEYS.starred) && clearedAll.includes(KEYS.tags));
expect("全部清空后收藏没了", [...readStarred()], []);
expect("全部清空后标签没了", loadTags(), {});
expect("全部清空后自定义模板没了", readRaw(KEYS.customNoteTemplates), null);
expect("全部清空后指标快照没了", readRaw(KEYS.snapshots), null);
expect("全部清空后统计归零", localFootprint(), { keys: 0, bytes: 0, ui: 0, data: 0 });
// 键分类完整性：新增键必须归入其中一类，漏了会被这两条抓住
const classified = new Set<string>([...UI_PREFERENCE_KEYS, ...USER_DATA_KEYS]);
expect("两类合起来覆盖全部登记键", [...classified].sort(), Object.values(KEYS).sort());
expect("两类之间没有重复键", classified.size, UI_PREFERENCE_KEYS.length + USER_DATA_KEYS.length);
const sidebarNow = fs.readFileSync(path.join(webSrc, "components", "Sidebar.tsx"), "utf8");
ok("侧栏有本机数据入口", sidebarNow.includes("本机数据"));
ok(
  "两个复位动作都是两步确认",
  sidebarNow.includes("再点一次：复位偏好") && sidebarNow.includes("再点一次：全部清空"),
);
ok("武装状态会自动解除", sidebarNow.includes("setArmedLocal(null), 4000"));
ok("弹层报出规模而不是闷头清", sidebarNow.includes("footprint.keys") && sidebarNow.includes("fmtBytes(footprint.bytes)"));

console.log(`[verify] 本地存储检查项=${checks} 失败=${failures.length}（扫过 ${files.length} 个前端文件）`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 20)) console.log(`  - ${f}`);
  console.log("[FAIL] 本地存储口径不符");
  process.exit(1);
}
console.log("[PASS] 本地存储正确（读写与降级 / 形状校验 / 脏数据回落 / 共享键一致 / 键登记 / 无绕过）");
