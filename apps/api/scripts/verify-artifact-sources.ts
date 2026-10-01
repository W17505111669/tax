/**
 * 验证脚本：产物溯源（生成产物 ↔ 工具调用）。
 * 用例形态取自真实工具结果：fill_land_vat_workpaper 的 outputPath（Windows 绝对路径）、
 * generate_workpaper 的 fileName + path、parse_uploaded_files 的嵌套数组。
 * 运行：pnpm verify:artsrc
 */
import { artifactSources, basename, namesInResult } from "../../web/src/artifact-sources.ts";
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.ts";
import { dirs } from "../src/config.ts";

const failures: string[] = [];
let checks = 0;

function expect(name: string, actual: unknown, want: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) failures.push(`${name}: 实际 ${a}，期望 ${w}`);
}

const DIR = "C:\\data\\outputs\\task-1";
const calls = [
  {
    id: "call-fill",
    toolName: "fill_land_vat_workpaper",
    at: "2026-09-28T08:05:28.000Z",
    ok: true,
    result: { outputPath: `${DIR}\\已填列-清算底稿（合同发票关联）.xlsx`, filledCells: 12 },
  },
  {
    id: "call-gen",
    toolName: "generate_workpaper",
    at: "2026-09-28T08:06:32.000Z",
    ok: true,
    result: {
      fileName: "底稿-土地增值税清算工作底稿.xlsx",
      path: `${DIR}\\底稿-土地增值税清算工作底稿.xlsx`,
      sheets: [{ name: "清算底稿", rowCount: 9 }],
    },
  },
  {
    id: "call-parse",
    toolName: "parse_uploaded_files",
    at: "2026-09-28T08:04:40.000Z",
    ok: true,
    result: { parsed: [{ fileName: "模板.xlsx", fileType: "xlsx", ok: true }] },
  },
  {
    id: "call-failed",
    toolName: "generate_workpaper",
    at: "2026-09-28T08:07:00.000Z",
    ok: false,
    result: { fileName: "底稿-失败产物.xlsx" },
  },
];

const N_FILL = "已填列-清算底稿（合同发票关联）.xlsx";
const N_GEN = "底稿-土地增值税清算工作底稿.xlsx";
const N_TPL = "模板.xlsx";
const N_FAILED = "底稿-失败产物.xlsx";
const N_UNKNOWN = "没有来源的产物.xlsx";
const src = artifactSources([N_FILL, N_GEN, N_TPL, N_FAILED, N_UNKNOWN], calls);

expect("Windows 绝对路径的 outputPath 可溯源", src.get(N_FILL)?.id, "call-fill");
expect("fileName + path 可溯源", src.get(N_GEN)?.id, "call-gen");
expect("嵌套数组里的 fileName 可溯源", src.get(N_TPL)?.id, "call-parse");
expect("失败调用不作为来源", src.get(N_FAILED), undefined);
expect("无来源产物不入表", src.has(N_UNKNOWN), false);
expect("白名单键认定为生产者", src.get(N_GEN)?.role, "producer");

// 引用级兜底：产物只在某次调用结果里被提到（例如比对的人工底稿输入），标记为 ref 而不是生产者
const refCalls = [
  {
    id: "call-cmp",
    toolName: "compare_workpapers",
    at: "2026-09-28T04:49:50.000Z",
    ok: true,
    result: { a: "底稿-系统.xlsx", b: "底稿-人工.xlsx", totals: { compared: 2 } },
  },
];
const refSrc = artifactSources(["底稿-人工.xlsx", "底稿-系统.xlsx"], refCalls);
expect("非白名单键按引用溯源", refSrc.get("底稿-人工.xlsx")?.role, "ref");
expect("引用溯源带调用信息", refSrc.get("底稿-人工.xlsx")?.id, "call-cmp");
expect("生产者优先于引用", artifactSources(["底稿-人工.xlsx"], [
  { id: "gen", toolName: "generate_workpaper", at: "2026-09-28T04:00:00.000Z", ok: true, result: { fileName: "底稿-人工.xlsx" } },
  ...refCalls,
]).get("底稿-人工.xlsx"), { id: "gen", toolName: "generate_workpaper", at: "2026-09-28T04:00:00.000Z", role: "producer" });
expect("来源带工具名与时间", [src.get(N_GEN)?.toolName, src.get(N_GEN)?.at], [
  "generate_workpaper",
  "2026-09-28T08:06:32.000Z",
]);

// 同一产物多次生成：取最后一次（覆盖写）
const regen = artifactSources(["底稿.xlsx"], [
  { id: "c1", toolName: "generate_workpaper", at: "2026-09-28T08:00:00.000Z", ok: true, result: { fileName: "底稿.xlsx" } },
  { id: "c2", toolName: "generate_workpaper", at: "2026-09-28T09:00:00.000Z", ok: true, result: { path: "/out/底稿.xlsx" } },
]);
expect("重复生成取最后一次", regen.get("底稿.xlsx")?.id, "c2");

// 工作表名等 name 字段不会被误判为产物
expect("工作表名不误判", namesInResult({ sheets: [{ name: "底稿-土地增值税清算工作底稿.xlsx" }] }), []);
expect("基名兼容两种分隔符", [basename("C:\\a\\b.xlsx"), basename("/out/b.xlsx"), basename("b.xlsx")], [
  "b.xlsx",
  "b.xlsx",
  "b.xlsx",
]);
expect("非对象结果返回空", namesInResult("底稿.xlsx"), []);
expect("空调用列表", artifactSources(["a.xlsx"], []).size, 0);

// 5) 真实数据：产物目录 × 工具调用结果的溯源命中率（阈值防回归；未命中项作为提示输出）
const tasks = db.prepare(`SELECT id FROM tasks`).all() as Array<{ id: string }>;
let total = 0;
let hit = 0;
const misses: string[] = [];
for (const t of tasks) {
  const dir = path.join(dirs.outputs, t.id);
  if (!fs.existsSync(dir)) continue;
  const names = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  if (names.length === 0) continue;
  const rows = db
    .prepare(`SELECT id, tool_name, result, ok, started_at FROM tool_calls WHERE task_id = ? ORDER BY started_at ASC`)
    .all(t.id) as Array<{ id: string; tool_name: string; result: string | null; ok: number | null; started_at: string }>;
  const calls = rows.map((c) => {
    let result: unknown = null;
    try {
      result = c.result ? JSON.parse(c.result) : null;
    } catch {
      result = null;
    }
    return {
      id: c.id,
      toolName: c.tool_name,
      at: c.started_at,
      ok: c.ok === 1 ? true : c.ok === 0 ? false : null,
      result,
    };
  });
  const src = artifactSources(names, calls);
  for (const n of names) {
    total += 1;
    if (src.has(n)) hit += 1;
    else misses.push(`${t.id.slice(0, 8)}/${n}`);
  }
}
expect("真实产物溯源率不低于 90%", total === 0 || hit / total >= 0.9, true);
console.log(
  `[verify] 真实产物=${total} 已溯源=${hit} 未溯源=${misses.length}${
    misses.length > 0 ? `（${misses.slice(0, 3).join("；")}）` : ""
  }`,
);

// 防空跑：产物溯源的真实走查在空库下一条都不跑，纯函数断言照样全绿
expect(
  "确实走到了真实任务（空库不算通过）",
  (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n >= 1,
  true,
);
console.log(`[verify] 产物溯源检查项=${checks} 失败=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  console.log("[FAIL] 产物溯源规则不符");
  process.exit(1);
}
console.log("[PASS] 产物溯源规则正确（路径基名 / 嵌套结果 / 覆盖写取最后一次 / 失败调用排除）");
